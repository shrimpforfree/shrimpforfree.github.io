// Smooth scrolling for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});


// Project expand/collapse functionality
function toggleProject(header) {
    const projectItem = header.parentElement;
    const isExpanded = projectItem.classList.contains('expanded');
    
    // Close all other projects
    const allProjects = document.querySelectorAll('.project-item');
    allProjects.forEach(item => {
        if (item !== projectItem) {
            item.classList.remove('expanded');
        }
    });
    
    // Toggle current project
    projectItem.classList.toggle('expanded', !isExpanded);
}

// Keyboard accessibility for projects
document.addEventListener('DOMContentLoaded', function() {
    const projectHeaders = document.querySelectorAll('.project-header');
    
    projectHeaders.forEach(header => {
        // Make headers focusable
        header.setAttribute('tabindex', '0');
        header.setAttribute('role', 'button');
        header.setAttribute('aria-expanded', 'false');
        
        // Handle keyboard events
        header.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleProject(this);
                
                // Update aria-expanded
                const isExpanded = this.parentElement.classList.contains('expanded');
                this.setAttribute('aria-expanded', isExpanded);
            }
        });
        
        // Update aria-expanded on click
        header.addEventListener('click', function() {
            setTimeout(() => {
                const isExpanded = this.parentElement.classList.contains('expanded');
                this.setAttribute('aria-expanded', isExpanded);
            }, 10);
        });
    });

    // Add loading animation for images
    const images = document.querySelectorAll('img');
    images.forEach(img => {
        img.addEventListener('load', function() {
            this.style.opacity = '1';
        });
    });
});