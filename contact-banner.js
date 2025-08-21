// Contact Banner Component
class ContactBanner {
    constructor() {
        this.bannerHTML = `
            <footer id="contact" class="contact-footer">
                <div class="container">
                    <h2>Let's Connect</h2>
                    <div class="contact-simple">
                        <p>Interested in collaborating on a project or discussing opportunities? I'd love to hear from you!</p>
                        
                        <div class="contact-links">
                            <a href="mailto:brian920922@gmail.com" class="contact-link" aria-label="Email Brian Chen">
                                📧 brian920922@gmail.com
                            </a>
                            <a href="tel:+19178539009" class="contact-link" aria-label="Call Brian Chen">
                                📱 (917) 853-9009
                            </a>
                            <a href="https://github.com/shrimpforfree" class="contact-link" target="_blank" rel="noopener noreferrer" aria-label="Brian's GitHub Profile">
                                🐙 GitHub
                            </a>
                            <a href="https://www.linkedin.com/in/brian-chen-07661a267/" class="contact-link" target="_blank" rel="noopener noreferrer" aria-label="Brian's LinkedIn Profile">
                                💼 LinkedIn
                            </a>
                        </div>
                        
                        <p class="copyright">&copy; 2025 Brian Chen. All rights reserved.</p>
                    </div>
                </div>
            </footer>
        `;

        this.bannerCSS = `
            /* Contact Footer Banner */
            .contact-footer {
                background: var(--card);
                padding: 40px 0 25px 0;
                margin-top: 0;
                border-top: 1px solid var(--border);
            }

            .contact-footer h2 {
                font-size: 2.5rem;
                text-align: center;
                margin-bottom: 20px;
                color: var(--accent);
            }

            .contact-simple {
                text-align: center;
                max-width: 900px;
                margin: 0 auto;
            }

            .contact-simple p {
                margin-bottom: 20px;
                font-size: 1.1rem;
            }

            .contact-links {
                display: flex;
                justify-content: center;
                gap: 15px;
                margin: 30px 0;
                flex-wrap: nowrap;
            }

            .contact-link {
                color: var(--accent);
                text-decoration: none;
                font-weight: 600;
                font-size: 0.9rem;
                transition: transform 0.2s, color 0.2s;
                display: inline-block;
                padding: 8px 12px;
                border-radius: 6px;
                background: var(--bg);
                box-shadow: 0 2px 8px var(--shadow);
                min-width: 100px;
            }

            .contact-link:hover {
                transform: translateY(-2px);
                color: var(--accent-hover);
                box-shadow: 0 5px 20px var(--shadow);
            }

            .copyright {
                margin-top: 15px !important;
                color: var(--text);
                opacity: 0.8;
                font-size: 0.9rem;
            }

            @media (max-width: 768px) {
                .contact-links {
                    flex-direction: column;
                    align-items: center;
                }

                .contact-footer h2 {
                    font-size: 2rem;
                }
            }
        `;
    }

    // Inject CSS styles
    injectStyles() {
        const styleElement = document.createElement('style');
        styleElement.textContent = this.bannerCSS;
        document.head.appendChild(styleElement);
    }

    // Render the contact banner
    render(targetElement = null) {
        // Inject styles first
        this.injectStyles();

        if (targetElement) {
            // If target element is specified, insert before it
            targetElement.insertAdjacentHTML('beforebegin', this.bannerHTML);
        } else {
            // Default: append to body
            document.body.insertAdjacentHTML('beforeend', this.bannerHTML);
        }
    }

    // Initialize contact banner when DOM is ready
    init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                // Find the last script tag to insert banner before it
                const scripts = document.querySelectorAll('script');
                const lastScript = scripts[scripts.length - 1];
                this.render(lastScript);
            });
        } else {
            const scripts = document.querySelectorAll('script');
            const lastScript = scripts[scripts.length - 1];
            this.render(lastScript);
        }
    }
}

// Auto-initialize if this script is loaded
if (typeof window !== 'undefined') {
    window.ContactBanner = ContactBanner;
    
    // Auto-initialize contact banner
    const contactBanner = new ContactBanner();
    contactBanner.init();
}