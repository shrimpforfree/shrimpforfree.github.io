// widgets/raft.js
//
// A 7-node Raft cluster, running real leader-election logic in real
// time. Implements the bits that are visually interesting:
//
//   - Followers run an *election timeout* (randomized 1.5–3.0 s).
//     If no heartbeat arrives, they become candidates: bump term,
//     vote for self, send RequestVote to everyone else.
//   - Candidates that collect a majority of vote-granted responses
//     become leader.
//   - Leaders send periodic heartbeats; followers reset their
//     election timer on receipt.
//   - Higher term always wins: a node receiving any message with a
//     term greater than its own steps down to follower.
//
// Skipped (would double the code, not the impression):
//   - log replication and the AppendEntries RPC
//   - the safety/log-up-to-date check on RequestVote
//   - persistent state across restarts
//
// Colors:
//   leader    = blue        (steel)
//   candidate = rust        (warm)
//   follower  = cream
//   dead      = grey
//
// Messages (small dots travelling between nodes):
//   reqvote     = rust
//   votegranted = blue
//   votedenied  = grey
//   heartbeat   = ochre
//
// Click [ kill leader ] to introduce a partition/failure on demand.
// The cluster will time out, hold a new election, and elect a fresh
// leader. After ~4 s the dead node revives and rejoins as a follower.
// References: Ongaro & Ousterhout, "In Search of an Understandable
// Consensus Algorithm" (USENIX ATC '14).

import { mount, place, onResize, visibility, reducedMotion, responsiveWidth }
  from './_helpers.js';

const MIN_W   = 320;
const MAX_W   = 520;
const N_NODES = 7;
const MAJORITY = Math.floor(N_NODES / 2) + 1;   // votes needed to win an election

// Tune these to make the simulation faster / slower / more dramatic.
const HEARTBEAT_MS        = 600;
const ELECTION_MIN_MS     = 1500;
const ELECTION_MAX_MS     = 3000;
const LEADER_LIFETIME_MIN = 5000;
const LEADER_LIFETIME_MAX = 9000;
const REVIVE_AFTER_MS     = 4000;
const MSG_DURATION_MS     = 400;
// Client requests fly in from off-canvas; the leader appends each
// one to its log, then replicates via AppendEntries.
const CLIENT_REQ_MIN_MS   = 1400;
const CLIENT_REQ_MAX_MS   = 2600;
const LOG_DISPLAY_MAX     = 8;     // last N entries shown per node

export function raft({ side = 'left', top = 2500 } = {}) {
  let W = MIN_W, H = MIN_W;
  let nodes = [];
  let messages = [];
  let scriptedKillAt = null;
  let scriptedReviveAt = null;
  let nextClientReqAt = 0;
  let logLine = '';
  let lastTime = performance.now();
  let rafId = null;

  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');

  const { wrap } = mount({
    content: canvas,
    label: '// raft consensus · 7-node cluster',
    controls: [
      { id: 'kill',  text: '[ kill leader ]', onClick: killLeader },
      { id: 'reset', text: '[ reset ]',       onClick: reset      },
    ],
  });

  function relayout() {
    W = H = responsiveWidth({ min: MIN_W, max: MAX_W });
    if (!place(wrap, { side, top, width: W })) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    positionNodes();
    draw();
  }

  // ---- topology -------------------------------------------------

  function positionNodes() {
    const cx = W / 2, cy = H / 2;
    const r  = Math.min(W, H) * 0.35;
    for (let i = 0; i < nodes.length; i++) {
      const a = (i / N_NODES) * Math.PI * 2 - Math.PI / 2;   // start at 12 o'clock
      nodes[i].x = cx + r * Math.cos(a);
      nodes[i].y = cy + r * Math.sin(a);
    }
  }

  function reset() {
    nodes = [];
    for (let i = 0; i < N_NODES; i++) {
      nodes.push({
        id: i,
        state: 'follower',
        term: 0,
        votedFor: null,
        votesReceived: 0,
        electionTimeout: randomElection(),
        heartbeatTimer: 0,
        alive: true,
        x: 0, y: 0,
        // Replicated state: each entry is just { term }; commitIndex
        // tracks how many of those entries are committed (idx < commitIndex).
        log: [],
        commitIndex: 0,
        // Leaders only: per-follower index of the next entry to send.
        // Used to size AppendEntries payloads + count replicas.
        matchIndex: {},
      });
    }
    messages = [];
    scriptedKillAt = performance.now() + 4500;
    scriptedReviveAt = null;
    nextClientReqAt = performance.now() + 3500;   // wait for first leader
    logLine = 'cluster start';
    positionNodes();
    draw();
  }

  function randomElection() {
    return ELECTION_MIN_MS + Math.random() * (ELECTION_MAX_MS - ELECTION_MIN_MS);
  }
  function findLeader() { return nodes.find(n => n.state === 'leader' && n.alive); }

  function killLeader() {
    const ldr = findLeader();
    if (!ldr) return;
    ldr.alive = false;
    ldr.state = 'follower';
    logLine = `node ${ldr.id} died · term ${ldr.term}`;
    scriptedReviveAt = performance.now() + REVIVE_AFTER_MS;
    scriptedKillAt = null;
  }

  // ---- main loop ------------------------------------------------

  function frame() {
    const now = performance.now();
    const dt = Math.min(64, now - lastTime);    // cap dt so tab-resume doesn't fire 1000 events
    lastTime = now;
    update(dt, now);
    draw();
    rafId = requestAnimationFrame(frame);
  }

  function update(dt, now) {
    // Move messages along the wire.
    for (const m of messages) m.progress += dt / m.duration;
    // Deliver any that arrived this frame.
    for (const m of messages) if (m.progress >= 1) handleMessage(m);
    messages = messages.filter(m => m.progress < 1);

    // Tick each live node's timers.
    for (const n of nodes) {
      if (!n.alive) continue;
      if (n.state !== 'leader') {
        n.electionTimeout -= dt;
        if (n.electionTimeout <= 0) startElection(n);
      } else {
        n.heartbeatTimer -= dt;
        if (n.heartbeatTimer <= 0) {
          sendAppendEntries(n);
          n.heartbeatTimer = HEARTBEAT_MS;
        }
      }
    }

    // Client requests: every CLIENT_REQ_*_MS, fire a 'clientreq'
    // dart from off-canvas at the current leader. On arrival the
    // leader appends a new entry to its log.
    if (now >= nextClientReqAt) {
      nextClientReqAt = now + CLIENT_REQ_MIN_MS +
        Math.random() * (CLIENT_REQ_MAX_MS - CLIENT_REQ_MIN_MS);
      const ldr = findLeader();
      if (ldr) sendClientReq(ldr);
    }

    // Scripted drama: kill the standing leader after a while; revive after a pause.
    if (scriptedKillAt && now >= scriptedKillAt && findLeader()) killLeader();
    if (scriptedReviveAt && now >= scriptedReviveAt) {
      const dead = nodes.find(n => !n.alive);
      if (dead) {
        dead.alive = true;
        dead.state = 'follower';
        dead.electionTimeout = randomElection();
        logLine = `node ${dead.id} revived`;
      }
      scriptedReviveAt = null;
      scriptedKillAt = now + LEADER_LIFETIME_MIN +
        Math.random() * (LEADER_LIFETIME_MAX - LEADER_LIFETIME_MIN);
    }
  }

  // ---- raft transitions -----------------------------------------

  function startElection(n) {
    n.state = 'candidate';
    n.term++;
    n.votedFor = n.id;
    n.votesReceived = 1;
    n.electionTimeout = randomElection();
    logLine = `node ${n.id} → candidate · term ${n.term}`;
    for (const o of nodes) {
      if (o.id === n.id || !o.alive) continue;
      send(n.id, o.id, 'reqvote', n.term);
    }
  }

  // AppendEntries — Raft's swiss-army RPC. It's the heartbeat AND
  // the log-replication carrier. Each one to follower o carries:
  //   - leader's term
  //   - leader's commitIndex (so o can advance its own)
  //   - any entries past o's matchIndex
  // Followers always return 'appendack' with their current log
  // length so the leader can update matchIndex and decide what to
  // commit.
  function sendAppendEntries(n) {
    for (const o of nodes) {
      if (o.id === n.id) continue;
      const startIdx = n.matchIndex[o.id] || 0;
      const entries  = n.log.slice(startIdx);
      send(n.id, o.id, 'append', n.term, {
        entries,
        prevIdx: startIdx,
        leaderCommit: n.commitIndex,
      });
    }
  }

  // Client request: a dart fired in from outside the cluster at the
  // leader. We model it as an inbound message with a synthetic
  // "from" position (offscreen) so the renderer can draw the wire.
  function sendClientReq(ldr) {
    messages.push({
      from: -1,             // synthetic: client lives off-canvas
      to: ldr.id,
      type: 'clientreq',
      term: ldr.term,
      progress: 0,
      duration: MSG_DURATION_MS,
    });
  }

  function send(from, to, type, term, payload) {
    messages.push({
      from, to, type, term, payload,
      progress: 0, duration: MSG_DURATION_MS,
    });
  }

  function handleMessage(m) {
    const target = nodes[m.to];
    if (!target.alive) return;

    // Universal rule: any message with higher term forces step-down.
    if (m.term > target.term && (m.type === 'append' || m.type === 'reqvote')) {
      target.term = m.term;
      target.state = 'follower';
      target.votedFor = null;
    }

    if (m.type === 'reqvote') {
      const canGrant = m.term >= target.term &&
                       (target.votedFor === null || target.votedFor === m.from);
      if (canGrant) {
        target.term = m.term;
        target.votedFor = m.from;
        target.electionTimeout = randomElection();
        send(target.id, m.from, 'votegranted', m.term);
      } else {
        send(target.id, m.from, 'votedenied', target.term);
      }
    }
    else if (m.type === 'votegranted') {
      if (target.state === 'candidate' && m.term === target.term) {
        target.votesReceived++;
        if (target.votesReceived > N_NODES / 2) {
          target.state = 'leader';
          target.heartbeatTimer = 0;
          // Reset matchIndex for the new term — followers haven't
          // confirmed any of our log entries yet.
          target.matchIndex = {};
          logLine = `node ${target.id} elected leader · term ${target.term}`;
        }
      }
    }
    else if (m.type === 'append') {
      // Heartbeat-equivalent: resets election timer. Also delivers
      // any new entries and advances the local commitIndex.
      if (m.term >= target.term) {
        target.term = m.term;
        target.state = 'follower';
        target.electionTimeout = randomElection();
        const p = m.payload;
        if (p && p.entries && p.entries.length) {
          // Splice the new entries in at prevIdx — overwrites any
          // stale tail (the simplification: real Raft does a
          // consistency check; for the viz we trust the leader).
          target.log.length = p.prevIdx;
          for (const e of p.entries) target.log.push({ term: e.term });
        }
        if (p && typeof p.leaderCommit === 'number') {
          target.commitIndex = Math.min(p.leaderCommit, target.log.length);
        }
        send(target.id, m.from, 'appendack', target.term, {
          matchIndex: target.log.length,
        });
      }
    }
    else if (m.type === 'appendack') {
      if (target.state === 'leader' && m.term === target.term) {
        target.matchIndex[m.from] = m.payload.matchIndex;
        // Advance commitIndex: highest idx s.t. ≥ MAJORITY nodes
        // have replicated. Self counts; others use matchIndex.
        for (let idx = target.log.length; idx > target.commitIndex; idx--) {
          let count = 1;   // leader itself has it
          for (const o of nodes) {
            if (o.id === target.id) continue;
            if ((target.matchIndex[o.id] || 0) >= idx) count++;
          }
          if (count >= MAJORITY) {
            target.commitIndex = idx;
            logLine = `node ${target.id} commit · idx ${idx}`;
            break;
          }
        }
      }
    }
    else if (m.type === 'clientreq') {
      // Client write — leader appends a new entry (term-stamped).
      if (target.state === 'leader') {
        target.log.push({ term: target.term });
        logLine = `client → N${target.id} · log ${target.log.length}`;
      }
    }
  }

  // ---- drawing --------------------------------------------------

  function colorForNode(n) {
    if (!n.alive)              return 'rgba(28, 31, 36, 0.25)';
    if (n.state === 'leader')    return 'rgba(47, 106, 160, 0.92)';
    if (n.state === 'candidate') return 'rgba(194, 83, 43, 0.85)';
    return 'rgba(243, 239, 230, 1)';
  }

  function colorForMessage(t) {
    if (t === 'reqvote')     return 'rgba(194, 83, 43, 0.85)';
    if (t === 'votegranted') return 'rgba(47, 106, 160, 0.85)';
    if (t === 'votedenied')  return 'rgba(28, 31, 36, 0.45)';
    if (t === 'append')      return 'rgba(150, 130, 60, 0.75)';   // heartbeat-ish
    if (t === 'appendack')   return 'rgba(110, 140, 90, 0.65)';   // forest
    if (t === 'clientreq')   return 'rgba(180, 140, 50, 0.95)';   // gold
    return 'rgba(28, 31, 36, 0.50)';
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);

    // Faint mesh of all-pairs edges.
    ctx.strokeStyle = 'rgba(28, 31, 36, 0.10)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        ctx.beginPath();
        ctx.moveTo(nodes[i].x, nodes[i].y);
        ctx.lineTo(nodes[j].x, nodes[j].y);
        ctx.stroke();
      }
    }

    // Messages — small dots travelling along the wire. Client
    // requests have no node source so we anchor them at a fixed
    // off-canvas point (top-right corner area) and let them dart in
    // toward the leader.
    const clientOrigin = { x: W - 8, y: 18 };
    for (const m of messages) {
      const a = m.from === -1 ? clientOrigin : nodes[m.from];
      const b = nodes[m.to];
      const t = m.progress;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      ctx.fillStyle = colorForMessage(m.type);
      // Client requests get a slightly bigger gold dot — they're the
      // 'external' event, not internal cluster chatter.
      const r = m.type === 'clientreq' ? 4 : 3;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Nodes.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const n of nodes) {
      ctx.fillStyle = colorForNode(n);
      ctx.strokeStyle = n.alive ? 'rgba(28, 31, 36, 0.50)' : 'rgba(28, 31, 36, 0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, 17, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Vote progress ring around candidates: arc sweeps from 12 o'clock,
      // filling to a full circle when this candidate has won (votes >=
      // majority). Brightens as it approaches the threshold.
      if (n.alive && n.state === 'candidate') {
        const progress = Math.min(1, n.votesReceived / MAJORITY);
        const alpha = 0.45 + 0.45 * progress;
        ctx.strokeStyle = `rgba(194, 83, 43, ${alpha})`;
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.arc(n.x, n.y, 22, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
        ctx.stroke();
      }

      const isAccent = n.alive && (n.state === 'leader' || n.state === 'candidate');
      ctx.fillStyle = isAccent ? 'white' : 'rgba(28, 31, 36, 0.85)';
      ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.fillText(`N${n.id}`, n.x, n.y - 4);
      ctx.font = "8px 'JetBrains Mono', monospace";
      ctx.fillText(`t${n.term}`, n.x, n.y + 7);

      // Vote tally below the node — only meaningful for live candidates.
      if (n.alive && n.state === 'candidate') {
        ctx.fillStyle = 'rgba(194, 83, 43, 0.95)';
        ctx.font = "9px 'JetBrains Mono', monospace";
        ctx.fillText(`${n.votesReceived}/${MAJORITY}`, n.x, n.y + 30);
      }

      // Log strip — last few entries above the node. Filled =
      // committed (durable across the cluster), outlined = received
      // but not yet committed. Watch the strip "fill in" as a new
      // entry replicates and the leader advances commitIndex.
      if (n.log.length) {
        const total = n.log.length;
        const start = Math.max(0, total - LOG_DISPLAY_MAX);
        const cellW = 5, cellH = 6, gap = 1;
        const stripW = (cellW + gap) * (total - start) - gap;
        const stripX = n.x - stripW / 2;
        const stripY = n.y - 32;
        for (let i = start; i < total; i++) {
          const x = stripX + (i - start) * (cellW + gap);
          const committed = i < n.commitIndex;
          if (committed) {
            ctx.fillStyle = 'rgba(47, 106, 160, 0.92)';
            ctx.fillRect(x, stripY, cellW, cellH);
          } else {
            ctx.strokeStyle = 'rgba(47, 106, 160, 0.65)';
            ctx.lineWidth = 0.8;
            ctx.strokeRect(x + 0.5, stripY + 0.5, cellW - 1, cellH - 1);
          }
        }
      }
    }

    // Cluster summary, top-left.
    const ldr = findLeader();
    const summary = ldr ? `leader N${ldr.id} · term ${ldr.term}` : 'no leader · electing…';
    ctx.fillStyle = 'rgba(47, 106, 160, 0.85)';
    ctx.font = "italic 13px 'Instrument Serif', serif";
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(summary, 10, 8);

    // Last event, bottom-left.
    ctx.fillStyle = 'rgba(28, 31, 36, 0.55)';
    ctx.font = "9.5px 'JetBrains Mono', monospace";
    ctx.fillText(logLine, 10, H - 14);
  }

  function start() {
    lastTime = performance.now();
    if (!rafId) rafId = requestAnimationFrame(frame);
  }
  function stop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  visibility(wrap, { onShow: start, onHide: stop });
  onResize(relayout);

  reset();
  relayout();
  if (!reducedMotion()) start();
}
