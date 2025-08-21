// Navigation Bar Component
class NavigationBar {
    constructor(options = {}) {
        this.options = {
            backLink: options.backLink || 'index.html',
            backText: options.backText || '← Back to Portfolio',
            badges: options.badges || [],
            showBadges: options.showBadges !== false, // Default to true
            isHomePage: options.isHomePage || false
        };

        this.navHTML = `
            <nav class="project-nav ${this.options.isHomePage ? 'home-nav' : ''}">
                <div class="container">
                    <div class="nav-left">
                        <a href="index.html" class="nav-logo" aria-label="Go to homepage">BC</a>
                        ${this.options.isHomePage ? 
                            `<div class="nav-brand">${this.options.backText}</div>` : 
                            `<a href="${this.options.backLink}" class="back-link">${this.options.backText}</a>`
                        }
                    </div>
                    ${this.options.showBadges ? this.generateBadges() : ''}
                </div>
            </nav>
        `;

        this.navCSS = `
            /* Navigation Bar */
            .project-nav {
                background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 50%, rgba(45, 90, 61, 0.03) 100%);
                padding: 15px 0;
                border-bottom: 1px solid #e5e7eb;
                box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
                position: sticky;
                top: 0;
                z-index: 100;
            }

            .project-nav .container {
                display: flex;
                justify-content: space-between;
                align-items: center;
            }

            .nav-left {
                display: flex;
                align-items: center;
                gap: 15px;
            }

            .nav-logo {
                background: var(--accent);
                color: white;
                width: 32px;
                height: 32px;
                border-radius: 6px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: 700;
                font-size: 0.9rem;
                letter-spacing: 0.5px;
                text-decoration: none;
                transition: background-color 0.2s, transform 0.2s;
            }

            .nav-logo:hover {
                background: var(--accent-hover);
                transform: scale(1.05);
            }

            .back-link {
                color: var(--accent);
                text-decoration: none;
                font-weight: 600;
                font-size: 1rem;
                transition: color 0.2s;
            }

            .back-link:hover {
                color: var(--accent-hover);
            }

            .nav-brand {
                color: var(--accent);
                font-weight: 600;
                font-size: 1rem;
            }

            .project-badges {
                display: flex;
                gap: 10px;
            }

            .badge {
                background: var(--accent);
                color: white;
                padding: 4px 12px;
                border-radius: 15px;
                font-size: 0.8rem;
                font-weight: 500;
            }

            @media (max-width: 768px) {
                .project-nav .container {
                    flex-direction: column;
                    gap: 10px;
                    align-items: flex-start;
                }

                .project-badges {
                    flex-wrap: wrap;
                }
            }
        `;
    }

    // Generate badges HTML
    generateBadges() {
        if (!this.options.badges || this.options.badges.length === 0) {
            return '';
        }

        const badgesHTML = this.options.badges
            .map(badge => `<span class="badge">${badge}</span>`)
            .join('');

        return `<div class="project-badges">${badgesHTML}</div>`;
    }

    // Inject CSS styles
    injectStyles() {
        // Check if styles are already injected
        if (document.querySelector('#navigation-bar-styles')) {
            return;
        }

        const styleElement = document.createElement('style');
        styleElement.id = 'navigation-bar-styles';
        styleElement.textContent = this.navCSS;
        document.head.appendChild(styleElement);
    }

    // Render the navigation bar
    render(targetElement = null) {
        // Inject styles first
        this.injectStyles();

        if (targetElement) {
            // Insert after target element
            targetElement.insertAdjacentHTML('afterend', this.navHTML);
        } else {
            // Default: prepend to body (after opening body tag)
            document.body.insertAdjacentHTML('afterbegin', this.navHTML);
        }
    }

    // Initialize navigation bar when DOM is ready
    init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                this.render();
            });
        } else {
            this.render();
        }
    }

    // Static method for easy initialization
    static create(options = {}) {
        const nav = new NavigationBar(options);
        nav.init();
        return nav;
    }
}

// Auto-initialize if this script is loaded (for backward compatibility)
if (typeof window !== 'undefined') {
    window.NavigationBar = NavigationBar;
}