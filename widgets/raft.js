// widgets/raft.js
//
// A 5-node Raft cluster, running real leader-election logic in real
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

const MIN_W   = 360;
const MAX_W   = 520;
const N_NODES = 5;
const MAJORITY = Math.floor(N_NODES / 2) + 1;   // votes needed to win an election

// Tune these to make the simulation faster / slower / more dramatic.
const HEARTBEAT_MS        = 600;
const ELECTION_MIN_MS     = 1500;
const ELECTION_MAX_MS     = 3000;
const LEADER_LIFETIME_MIN = 5000;
const LEADER_LIFETIME_MAX = 9000;
const REVIVE_AFTER_MS     = 4000;
const MSG_DURATION_MS     = 400;

export function raft({ side = 'left', top = 2500 } = {}) {
  let W = MIN_W, H = MIN_W;
  let nodes = [];
  let messages = [];
  let scriptedKillAt = null;
  let scriptedReviveAt = null;
  let logLine = '';
  let lastTime = performance.now();
  let rafId = null;

  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');

  const { wrap } = mount({
    content: canvas,
    label: '// raft consensus · 5-node cluster',
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
      });
    }
    messages = [];
    scriptedKillAt = performance.now() + 4500;
    scriptedReviveAt = null;
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
          sendHeartbeats(n);
          n.heartbeatTimer = HEARTBEAT_MS;
        }
      }
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

  function sendHeartbeats(n) {
    for (const o of nodes) {
      if (o.id === n.id) continue;
      send(n.id, o.id, 'heartbeat', n.term);
    }
  }

  function send(from, to, type, term) {
    messages.push({ from, to, type, term, progress: 0, duration: MSG_DURATION_MS });
  }

  function handleMessage(m) {
    const target = nodes[m.to];
    if (!target.alive) return;

    // Universal rule: any message with higher term forces step-down.
    if (m.term > target.term && (m.type === 'heartbeat' || m.type === 'reqvote')) {
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
          logLine = `node ${target.id} elected leader · term ${target.term}`;
        }
      }
    }
    else if (m.type === 'heartbeat') {
      if (m.term >= target.term) {
        target.term = m.term;
        target.state = 'follower';
        target.electionTimeout = randomElection();
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
    if (t === 'heartbeat')   return 'rgba(150, 130, 60, 0.75)';
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

    // Messages — small dots travelling along the wire.
    for (const m of messages) {
      const a = nodes[m.from], b = nodes[m.to];
      const t = m.progress;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      ctx.fillStyle = colorForMessage(m.type);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
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
