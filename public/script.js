// PhoenixAI Studio - Public Site JavaScript

/* -------------------------------------------------------------------------
   Output-escaping helpers.
   Every string below is written into the page with innerHTML, so anything
   coming back from the API has to be escaped first. Without this, a quote or
   apostrophe in a template name breaks the surrounding markup, and any HTML
   stored through the admin panel executes as script in every visitor's
   browser (stored XSS).
   ------------------------------------------------------------------------- */
function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// For values dropped into an inline handler, e.g. onclick="f('...')".
function escArg(value) {
    return esc(String(value === null || value === undefined ? '' : value)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'"));
}

// For href/src. Blocks javascript:, data: and other script-bearing schemes
// while still allowing normal links, relative paths and anchors.
function safeUrl(value) {
    var url = String(value === null || value === undefined ? '' : value).trim();
    if (!url) return '';
    if (/^(https?:|mailto:|tel:|\/|#|\.\/|\.\.\/)/i.test(url)) return esc(url);
    if (/^[\w.\-]+\.[a-z]{2,}(\/|$)/i.test(url)) return esc('https://' + url);
    return '';
}

// Always an array, so .map() never throws on a record missing the field.
function asList(value) {
    return Array.isArray(value) ? value : [];
}

let currentTemplates = [];
let currentTemplateIndex = 0;
let currentZoom = 100;
let allTemplates = [];

// Cache for bootstrap data
let bootstrapCache = null;

// Load logo on page load
document.addEventListener('DOMContentLoaded', function() {
    loadBootstrapData();
    setupCategoryNavigation();
    setupNavbarScroll();
    setupActiveNavigation();
    setupNavbarCategoryLinks();
    setupCareerBuilderDropdown();
    setupCareerBuilderCards();
    setupDemoWebsitesControls();
    setupAIAgentsControls();
    setupAIAgentsDropdown();
    setFooterYear();
    setupLogoAdminShortcut();
});

// Load all public data from bootstrap endpoint (single request)
async function loadBootstrapData() {
    try {
        const response = await fetch('/api/public/bootstrap');
        if (!response.ok) throw new Error('Bootstrap request failed with status ' + response.status);
        const data = await response.json();

        // Cache the bootstrap data
        bootstrapCache = data;

        // Update logo
        if (data.logo) {
            updateLogoDisplay(data.logo);
        }

        // Update modules
        if (data.modules) {
            updateNavigationBasedOnModules(data.modules);
        }

        // Store data for existing load functions
        allTemplates = data.templates || [];

        // Load pet settings
        if (data.pet && data.pet.enabled) {
            // Existing pet loading logic
        }

        // Now trigger existing load functions (they'll use cached data)
        loadAllTemplates();
        loadPackages();
        loadServices();
        loadDemoWebsites();
        loadAIAgents();

    } catch (error) {
        console.error('Error loading bootstrap data:', error);
        // Fall back to individual requests if bootstrap fails
        loadLogo();
        loadModules();
        loadAllTemplates();
        loadPackages();
        loadServices();
        loadDemoWebsites();
        loadAIAgents();
    }
}

/* Logo behaviour
   - 1 click  -> Home (scrolls to top if already on the home page)
   - 10 quick clicks (each within ~0.6s of the previous) -> opens the admin
     LOGIN page (/admin?login). It always asks for the password, even if an
     old session cookie is still valid; visitors who click the logo normally
     never see it. */
function setupLogoAdminShortcut() {
    const ADMIN_CLICKS = 10; // change this number to make the shortcut easier/harder
    const logo = document.querySelector('.brand-section a.logo');
    if (!logo) return;

    let clicks = 0;
    let timer = null;

    logo.addEventListener('click', function(e) {
        e.preventDefault();
        clicks += 1;
        clearTimeout(timer);

        if (clicks >= ADMIN_CLICKS) {
            clicks = 0;
            window.location.href = '/admin?login';
            return;
        }

        timer = setTimeout(function() {
            const wasSingle = clicks === 1;
            clicks = 0;
            if (!wasSingle) return;
            if (window.location.pathname === '/' || window.location.pathname === '/index.html') {
                window.scrollTo({ top: 0, behavior: 'smooth' });
            } else {
                window.location.href = '/';
            }
        }, 600);
    });
}

// Keep the copyright line current without a redeploy each January.
function setFooterYear() {
    const el = document.getElementById('footer-year');
    if (el) el.textContent = new Date().getFullYear();
}

// Load modules configuration
async function loadModules() {
    try {
        const response = await fetch('/api/modules');
        const modules = await response.json();
        updateNavigationBasedOnModules(modules);
    } catch (error) {
        console.error('Error loading modules:', error);
    }
}

// Show/hide public-site sections according to the admin "Modules" settings.
// NOTE: /api/modules returns ONLY the enabled modules, so a module that is
// missing from the response is a disabled one. (The old code looked for
// `module.enabled === false`, which never occurs in that response, and it
// had no entry at all for Career Builder — so the toggle did nothing.)
function updateNavigationBasedOnModules(modules) {
    if (!Array.isArray(modules) || modules.length === 0) return;
    const enabledIds = new Set(modules.filter(m => m.enabled).map(m => m.id));

    const hide = el => { if (el) el.style.display = 'none'; };
    const hideLinks = hrefs => {
        hrefs.forEach(href => {
            document.querySelectorAll('a[href="' + href + '"]').forEach(a => {
                // Footer links live in <li>; hide the whole row.
                hide(a.closest('.footer-links li') || a);
            });
        });
    };

    // module id -> what to hide when that module is disabled
    const targets = {
        // "Career Builder" module (Resume / Portfolio / Cover Letter templates)
        'templates': () => {
            document.querySelectorAll('#career-builder, #templates').forEach(hide);
            document.querySelectorAll('.career-link').forEach(a => hide(a.closest('.nav-dropdown')));
            document.querySelectorAll('.mobile-nav-group').forEach(g => {
                const title = g.querySelector('.mobile-nav-section');
                if (title && title.textContent.trim().toLowerCase() === 'career') hide(g);
            });
            hideLinks(['#career-builder', '#templates', '#resume', '#portfolio', '#cover-letter']);
        },
        'demo-websites': () => {
            document.querySelectorAll('#demo-websites').forEach(hide);
            hideLinks(['#demo-websites']);
        },
        'ai-agents': () => {
            document.querySelectorAll('#ai-agents, #ai-agents-demo').forEach(hide);
            hideLinks(['#ai-agents', '#ai-agents-demo']);
        }
    };

    Object.keys(targets).forEach(id => {
        if (!enabledIds.has(id)) targets[id]();
    });
}

// Toggle modules panel
function toggleModulesPanel() {
    const panel = document.getElementById('modules-panel');
    panel.classList.toggle('active');
}

// Close modules panel when clicking outside
document.addEventListener('click', (e) => {
    const panel = document.getElementById('modules-panel');
    const trigger = document.querySelector('.modules-trigger');
    
    if (panel && !panel.contains(e.target) && !trigger.contains(e.target)) {
        panel.classList.remove('active');
    }
});

// Setup navbar scroll behavior (rAF-throttled: the raw scroll event fires
// dozens of times per swipe and class writes force layout each time).
function setupNavbarScroll() {
    const header = document.querySelector('.header');
    if (!header) return;
    let ticking = false;

    window.addEventListener('scroll', () => {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(() => {
            header.classList.toggle('scrolled', window.pageYOffset > 50);
            ticking = false;
        });
    }, { passive: true });
}

// Highlight active navigation based on scroll
function setupActiveNavigation() {
    const sections = document.querySelectorAll('section[id]');
    const navLinks = document.querySelectorAll('.nav-link');
    
    window.addEventListener('scroll', () => {
        let current = '';
        
        sections.forEach(section => {
            const sectionTop = section.offsetTop;
            const sectionHeight = section.clientHeight;
            
            if (window.pageYOffset >= sectionTop - 100) {
                current = section.getAttribute('id');
            }
        });
        
        navLinks.forEach(link => {
            link.classList.remove('active');
            if (link.getAttribute('href') === `#${current}`) {
                link.classList.add('active');
            }
        });
    });
}

// Toggle mobile menu. Keeps aria-expanded in sync so screen readers announce
// the menu state, and restores the page's own scroll setting on close.
function setMobileMenu(open) {
    const mobileMenu = document.getElementById('mobile-menu');
    const trigger = document.querySelector('.mobile-menu-trigger');
    if (!mobileMenu) return;

    mobileMenu.classList.toggle('active', open);
    document.body.style.overflow = open ? 'hidden' : '';
    if (trigger) {
        trigger.setAttribute('aria-expanded', String(open));
        trigger.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
    }
}

function toggleMobileMenu() {
    const mobileMenu = document.getElementById('mobile-menu');
    setMobileMenu(!!mobileMenu && !mobileMenu.classList.contains('active'));
}

// Close mobile menu when clicking outside
document.addEventListener('click', function(e) {
    const mobileMenu = document.getElementById('mobile-menu');
    const mobileTrigger = document.querySelector('.mobile-menu-trigger');

    if (mobileMenu && mobileTrigger && !mobileMenu.contains(e.target) && !mobileTrigger.contains(e.target)) {
        if (mobileMenu.classList.contains('active')) {
            setMobileMenu(false);
        }
    }
});

// Escape closes the mobile menu too — it was previously only closable by tap.
document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    const mobileMenu = document.getElementById('mobile-menu');
    if (mobileMenu && mobileMenu.classList.contains('active')) setMobileMenu(false);
});

// Load logo from settings
async function loadLogo() {
    try {
        // Use cached bootstrap data if available
        if (bootstrapCache && bootstrapCache.logo) {
            updateLogoDisplay(bootstrapCache.logo);
            return;
        }

        const response = await fetch('/api/settings/logo');
        const data = await response.json();
        if (data.logo) {
            updateLogoDisplay(data.logo);
        }
    } catch (error) {
        console.error('Error loading logo:', error);
    }
}

function updateLogoDisplay(logoUrl) {
    const headerLogo = document.getElementById('header-logo');
    const footerLogo = document.getElementById('footer-logo');
    if (headerLogo) headerLogo.src = logoUrl;
    if (footerLogo) footerLogo.src = logoUrl;
}

// Load all templates
async function loadAllTemplates() {
    try {
        // Use cached bootstrap data if available
        if (bootstrapCache && bootstrapCache.templates) {
            allTemplates = bootstrapCache.templates;
            renderTemplates('featured-templates', allTemplates);
            return;
        }

        const response = await fetch('/api/templates');
        allTemplates = await response.json();
        renderTemplates('featured-templates', allTemplates);
    } catch (error) {
        console.error('Error loading templates:', error);
    }
}

// Setup category navigation
function setupCategoryNavigation() {
    const categoryBtns = document.querySelectorAll('.category-btn');
    categoryBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            // Update active state
            categoryBtns.forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            
            // Filter templates
            const category = this.getAttribute('data-category');
            filterTemplates(category);
        });
    });
}

// Load packages
let allPackages = [];
let packageCategoriesList = [];
let activePackageCategory = 'all';

async function loadPackages() {
    try {
        // Use cached bootstrap data if available
        if (bootstrapCache && bootstrapCache.packages && bootstrapCache.packageCategories) {
            allPackages = bootstrapCache.packages;
            packageCategoriesList = bootstrapCache.packageCategories;
            renderPackageCategoryTabs();
            renderPackages(filterPackagesByCategory(activePackageCategory));
            return;
        }

        const [pkgResponse, catResponse] = await Promise.all([
            fetch('/api/packages'),
            fetch('/api/package-categories')
        ]);
        allPackages = await pkgResponse.json();
        packageCategoriesList = await catResponse.json();
        renderPackageCategoryTabs();
        renderPackages(filterPackagesByCategory(activePackageCategory));
    } catch (error) {
        console.error('Error loading packages:', error);
        const container = document.getElementById('packages-grid');
        if (container) {
            container.innerHTML = '<p class="no-packages">Packages are currently being updated.</p>';
        }
    }
}

function filterPackagesByCategory(categoryId) {
    if (categoryId === 'all') return allPackages;
    return allPackages.filter(pkg => pkg.category === categoryId);
}

function renderPackageCategoryTabs() {
    const tabsContainer = document.getElementById('package-category-tabs');
    if (!tabsContainer) return;

    // Only show tabs for categories that actually have published packages
    const categoriesWithPackages = packageCategoriesList.filter(cat =>
        allPackages.some(pkg => pkg.category === cat.id)
    );

    if (categoriesWithPackages.length < 2) {
        tabsContainer.innerHTML = '';
        return;
    }

    const tabs = [{ id: 'all', name: 'All Packages' }, ...categoriesWithPackages];

    tabsContainer.innerHTML = tabs.map(cat => `
        <button type="button" class="package-category-tab ${cat.id === activePackageCategory ? 'active' : ''}" data-category="${esc(cat.id)}" aria-pressed="${cat.id === activePackageCategory}">
            ${esc(cat.name)}
        </button>
    `).join('');

    tabsContainer.querySelectorAll('.package-category-tab').forEach(btn => {
        btn.addEventListener('click', function () {
            activePackageCategory = this.getAttribute('data-category');
            tabsContainer.querySelectorAll('.package-category-tab').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            renderPackages(filterPackagesByCategory(activePackageCategory));
        });
    });
}

// Load services
async function loadServices() {
    try {
        // Use cached bootstrap data if available
        if (bootstrapCache && bootstrapCache.services) {
            renderServices(bootstrapCache.services);
            return;
        }

        const response = await fetch('/api/services');
        const services = await response.json();
        renderServices(services);
    } catch (error) {
        console.error('Error loading services:', error);
        const container = document.getElementById('services-grid');
        if (container) {
            container.innerHTML = '<p class="no-services">Services are currently being updated.</p>';
        }
    }
}

// Render packages to grid
function renderPackages(packages) {
    const container = document.getElementById('packages-grid');
    if (!container) return;
    
    if (packages.length === 0) {
        container.innerHTML = '<p class="no-packages">Packages are currently being updated.</p>';
        return;
    }
    
    container.innerHTML = packages.map(pkg => `
        <div class="package-card ${pkg.featured ? 'featured' : ''}">
            ${pkg.featured ? '<div class="featured-badge">FEATURED</div>' : ''}
            <h3 class="package-name">${esc(pkg.name)}</h3>
            <span class="package-category-badge">${esc(formatPackageCategory(pkg.category))}</span>
            <div class="package-price">${esc(pkg.currency)} ${esc(pkg.price)}</div>
            <div class="package-billing">${esc(pkg.billingType)}</div>
            <p class="package-description">${esc(pkg.description)}</p>
            <ul class="package-features">
                ${asList(pkg.features).map(feature => `<li>${esc(feature)}</li>`).join('')}
            </ul>
            <a href="${safeUrl(pkg.ctaLink) || '#project-start'}" class="package-cta">${esc(pkg.ctaText || 'Get Started')}</a>
        </div>
    `).join('');
}

// Render services to grid
function renderServices(services) {
    const container = document.getElementById('services-grid');
    if (!container) return;
    
    if (services.length === 0) {
        container.innerHTML = '<p class="no-services">Services are currently being updated.</p>';
        return;
    }
    
    container.innerHTML = services.map(service => `
        <div class="service-card ${service.featured ? 'featured' : ''}">
            ${service.featured ? '<div class="featured-badge">FEATURED</div>' : ''}
            ${service.thumbnail ? `<img src="${safeUrl(service.thumbnail)}" alt="${esc(service.name)}" class="service-thumbnail" loading="lazy" decoding="async">` : ''}
            <span class="service-category-badge">${esc(formatServiceCategory(service.category))}</span>
            <h3 class="service-name">${esc(service.name)}</h3>
            <p class="service-description">${esc(service.shortDescription)}</p>
            <a href="${safeUrl(service.ctaLink) || '#project-start'}" class="service-cta">${esc(service.ctaText || 'Learn More')}</a>
        </div>
    `).join('');
}

// Format service category for display
function formatServiceCategory(category) {
    const categoryMap = {
        'career-builder': 'Career Builder',
        'website-services': 'Website Services',
        'ai-agent-services': 'AI Agent Services',
        'business-solutions': 'Business Solutions',
        'digital-services': 'Digital Services',
        'other': 'Other'
    };
    return categoryMap[category] || category;
}

// Format package category for display
function formatPackageCategory(category) {
    const match = packageCategoriesList.find(c => c.id === category);
    if (match) return match.name;
    const categoryMap = {
        'career-builder': 'Career Builder',
        'website-module': 'Website Module',
        'ai-agent-module': 'AI Agent Module'
    };
    return categoryMap[category] || category;
}

// Setup navbar category links
function setupNavbarCategoryLinks() {
    const navLinks = document.querySelectorAll('.nav-link, .mobile-nav-link, .dropdown-item, [data-category-link]');
    
    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            const href = this.getAttribute('href');
            
            // Handle category links
            if (href === '#resume' || href === '#portfolio' || href === '#cover-letter') {
                e.preventDefault();
                
                // Extract category from href
                const category = href.substring(1); // Remove # and use the rest
                
                // Update category buttons
                const categoryBtns = document.querySelectorAll('.category-btn');
                categoryBtns.forEach(btn => {
                    btn.classList.remove('active');
                    if (btn.getAttribute('data-category') === category) {
                        btn.classList.add('active');
                    }
                });
                
                // Filter templates
                filterTemplates(category);
                
                // Scroll to templates section
                const templatesSection = document.getElementById('templates');
                if (templatesSection) {
                    templatesSection.scrollIntoView({
                        behavior: 'smooth',
                        block: 'start'
                    });
                }
                
                // Close mobile menu if open
                const mobileMenu = document.getElementById('mobile-menu');
                if (mobileMenu && mobileMenu.classList.contains('active')) {
                    setMobileMenu(false);
                }
            }
            
            // Handle mobile menu closing for non-category links
            if (this.classList.contains('mobile-nav-link') &&
                (href === '#home' || href === '#packages' || href === '#about')) {
                // Note: '/admin' is deliberately not handled here. It used to be,
                // which sent a non-selector string into querySelector — that throws
                // a SyntaxError and the link never navigated. Real page links are
                // now left alone so the browser follows them normally.
                e.preventDefault();
                const target = document.querySelector(href);
                if (target) {
                    target.scrollIntoView({
                        behavior: 'smooth',
                        block: 'start'
                    });
                }
                // Always close, never toggle — toggling could re-open the menu.
                setTimeout(() => setMobileMenu(false), 100);
            }
        });
    });
}

// Setup Career Builder dropdown functionality
function setupCareerBuilderDropdown() {
    const careerBuilderLink = document.querySelector('.career-link');
    
    if (careerBuilderLink) {
        careerBuilderLink.addEventListener('click', function(e) {
            const href = this.getAttribute('href');
            if (href === '#career-builder') {
                e.preventDefault();
                // Scroll to templates section and show all
                const templatesSection = document.getElementById('templates');
                if (templatesSection) {
                    templatesSection.scrollIntoView({
                        behavior: 'smooth',
                        block: 'start'
                    });
                }
                // Show all templates
                const allBtn = document.querySelector('.category-btn[data-category="all"]');
                if (allBtn) {
                    allBtn.click();
                }
            }
        });
    }
}

// Setup AI Agents dropdown functionality
function setupAIAgentsDropdown() {
    const aiAgentsLink = document.querySelector('.ai-agents-link');

    if (aiAgentsLink) {
        aiAgentsLink.addEventListener('click', function(e) {
            const href = this.getAttribute('href');
            if (href === '#ai-agents') {
                e.preventDefault();
                // Scroll to AI Agents section
                const aiAgentsSection = document.getElementById('ai-agents');
                if (aiAgentsSection) {
                    aiAgentsSection.scrollIntoView({
                        behavior: 'smooth',
                        block: 'start'
                    });
                }
            }
        });
    }
}

// Setup Career Builder cards
function setupCareerBuilderCards() {
    const careerBuilderCards = document.querySelectorAll('.career-builder-card');
    
    careerBuilderCards.forEach(card => {
        const cta = card.querySelector('.career-builder-cta');
        if (cta) {
            cta.addEventListener('click', function(e) {
                const category = card.getAttribute('data-category');
                if (category) {
                    e.preventDefault();
                    
                    // Update category buttons
                    const categoryBtns = document.querySelectorAll('.category-btn');
                    categoryBtns.forEach(btn => {
                        btn.classList.remove('active');
                        if (btn.getAttribute('data-category') === category) {
                            btn.classList.add('active');
                        }
                    });
                    
                    // Filter templates
                    filterTemplates(category);
                    
                    // Scroll to templates section
                    const templatesSection = document.getElementById('templates');
                    if (templatesSection) {
                        templatesSection.scrollIntoView({
                            behavior: 'smooth',
                            block: 'start'
                        });
                    }
                }
            });
        }
    });
}

// Filter templates by category
function filterTemplates(category) {
    if (category === 'all') {
        renderTemplates('featured-templates', allTemplates);
    } else {
        const filtered = allTemplates.filter(t => 
            t.category.toLowerCase() === category.toLowerCase()
        );
        renderTemplates('featured-templates', filtered);
    }
}

// Render templates to grid
function renderTemplates(containerId, templates) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    if (templates.length === 0) {
        container.innerHTML = '<p class="no-templates">No templates available yet.</p>';
        return;
    }
    
    container.innerHTML = templates.map(template => `
        <div class="template-card">
            ${safeUrl(template.thumbnail) ? `<img src="${safeUrl(template.thumbnail)}" alt="${esc(template.name)}" class="template-thumbnail" loading="lazy" decoding="async">` : '<div class="template-thumbnail placeholder" aria-hidden="true"></div>'}
            <div class="template-info">
                <h3 class="template-name">${esc(template.name)}</h3>
                <div class="template-meta">
                    <span class="tag" style="font-family: var(--font-accent);">${esc(template.category)}</span>
                    <span class="tag">${esc(template.style)}</span>
                </div>
                <p class="template-description">${esc(template.description)}</p>
                <div class="template-actions">
                    <button type="button" class="preview-button" onclick="openPreview('${escArg(template.id)}')" aria-label="View preview of ${esc(template.name)}">View Preview</button>
                    ${safeUrl(template.portfolioUrl) ? `<a href="${safeUrl(template.portfolioUrl)}" target="_blank" rel="noopener noreferrer" class="portfolio-button">Open Portfolio</a>` : ''}
                </div>
            </div>
        </div>
    `).join('');
}

// Open preview modal
async function openPreview(templateId) {
    try {
        const response = await fetch('/api/templates');
        const templates = await response.json();
        const template = templates.find(t => t.id === templateId);
        
        if (!template) return;
        
        currentTemplates = templates;
        currentTemplateIndex = templates.findIndex(t => t.id === templateId);
        currentZoom = 100;
        
        // Update modal content
        document.getElementById('modal-title').textContent = template.name;
        document.getElementById('modal-image').src = template.thumbnail;
        document.getElementById('modal-description').textContent = template.description;
        document.getElementById('modal-category').textContent = template.category;
        document.getElementById('modal-category').style.fontFamily = 'var(--font-accent)';
        document.getElementById('modal-style').textContent = template.style;
        document.getElementById('zoom-level').textContent = '100%';
        
        // Handle portfolio button
        const portfolioBtn = document.getElementById('modal-portfolio-btn');
        if (template.portfolioUrl) {
            portfolioBtn.href = template.portfolioUrl;
            portfolioBtn.style.display = 'inline-block';
        } else {
            portfolioBtn.style.display = 'none';
        }
        
        // Handle download button
        const downloadBtn = document.getElementById('modal-download-btn');
        if (template.pdf) {
            downloadBtn.href = template.pdf;
            downloadBtn.style.display = 'inline-block';
        } else {
            downloadBtn.style.display = 'none';
        }
        
        // Show modal
        document.getElementById('preview-modal').classList.add('active');
        document.body.style.overflow = 'hidden';
        
    } catch (error) {
        console.error('Error opening preview:', error);
    }
}

// Close modal
function closeModal() {
    document.getElementById('preview-modal').classList.remove('active');
    document.body.style.overflow = 'auto';
    currentZoom = 100;
}

// Zoom functions
function zoomIn() {
    if (currentZoom < 200) {
        currentZoom += 10;
        updateZoom();
    }
}

function zoomOut() {
    if (currentZoom > 50) {
        currentZoom -= 10;
        updateZoom();
    }
}

function updateZoom() {
    const image = document.getElementById('modal-image');
    image.style.transform = `scale(${currentZoom / 100})`;
    document.getElementById('zoom-level').textContent = `${currentZoom}%`;
}

// Navigate templates
function prevTemplate() {
    if (currentTemplateIndex > 0) {
        currentTemplateIndex--;
        const template = currentTemplates[currentTemplateIndex];
        updateModalContent(template);
    }
}

function nextTemplate() {
    if (currentTemplateIndex < currentTemplates.length - 1) {
        currentTemplateIndex++;
        const template = currentTemplates[currentTemplateIndex];
        updateModalContent(template);
    }
}

function updateModalContent(template) {
    document.getElementById('modal-title').textContent = template.name;
    document.getElementById('modal-image').src = template.thumbnail;
    document.getElementById('modal-description').textContent = template.description;
    document.getElementById('modal-category').textContent = template.category;
    document.getElementById('modal-category').style.fontFamily = 'var(--font-accent)';
    document.getElementById('modal-style').textContent = template.style;
    currentZoom = 100;
    document.getElementById('modal-image').style.transform = 'scale(1)';
    document.getElementById('zoom-level').textContent = '100%';
    
    const portfolioBtn = document.getElementById('modal-portfolio-btn');
    if (template.portfolioUrl) {
        portfolioBtn.href = template.portfolioUrl;
        portfolioBtn.style.display = 'inline-block';
    } else {
        portfolioBtn.style.display = 'none';
    }
    
    const downloadBtn = document.getElementById('modal-download-btn');
    if (template.pdf) {
        downloadBtn.href = template.pdf;
        downloadBtn.style.display = 'inline-block';
    } else {
        downloadBtn.style.display = 'none';
    }
}

// Close modal on escape key
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        closeModal();
    }
});

// Close modal on background click
document.getElementById('preview-modal').addEventListener('click', function(e) {
    if (e.target === this) {
        closeModal();
    }
});

// Smooth scrolling for navigation links (excluding category links)
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
        const href = this.getAttribute('href');
        
        // Skip category links as they're handled by setupNavbarCategoryLinks
        if (href === '#resume' || href === '#portfolio' || href === '#cover-letter') {
            return;
        }
        
        e.preventDefault();
        const target = document.querySelector(href);
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});

// Inquiry form submission
const inquiryForm = document.getElementById('inquiry-form');
if (inquiryForm) {
    inquiryForm.addEventListener('submit', async function (e) {
        e.preventDefault();

        const submitButton = inquiryForm.querySelector('button[type="submit"]');
        const errorBox = document.getElementById('inquiry-error');

        const showError = (msg) => {
            if (!errorBox) return;
            errorBox.textContent = msg;
            errorBox.style.display = 'block';
        };
        if (errorBox) errorBox.style.display = 'none';

        const name = document.getElementById('inquiry-name').value.trim();
        const email = document.getElementById('inquiry-email').value.trim();
        const phone = document.getElementById('inquiry-phone').value.trim();
        const service = document.getElementById('inquiry-service').value.trim();
        const budget = document.getElementById('inquiry-budget').value.trim();
        const message = document.getElementById('inquiry-message').value.trim();

        // Validation
        if (!name) {
            showError('Please enter your full name.');
            return;
        }

        if (!email) {
            showError('Please enter your email address.');
            return;
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            showError('Please enter a valid email address.');
            return;
        }

        if (!service) {
            showError('Please select a service or module.');
            return;
        }

        if (!message) {
            showError('Please enter your message or project details.');
            return;
        }

        if (message.length < 10) {
            showError('Please provide more details in your message (at least 10 characters).');
            return;
        }

        const formData = {
            name,
            email,
            phone,
            service,
            budget,
            message
        };

        // Guard against double submission while the request is in flight.
        const originalLabel = submitButton ? submitButton.textContent : '';
        if (submitButton) {
            submitButton.disabled = true;
            submitButton.textContent = 'Submitting...';
        }

        try {
            const response = await fetch('/api/admin/inquiries', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });

            const data = await response.json().catch(() => ({}));

            if (response.ok && data.success) {
                inquiryForm.style.display = 'none';
                const success = document.getElementById('inquiry-success');
                if (success) success.style.display = 'block';
                inquiryForm.reset();
            } else {
                // Surface the server's actual message (validation errors,
                // rate limiting, read-only storage) instead of a generic one.
                showError(data.error || 'Something went wrong. Please try again.');
            }
        } catch (error) {
            console.error('Error submitting inquiry:', error);
            showError('We could not reach the server. Please check your connection and try again.');
        } finally {
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.textContent = originalLabel;
            }
        }
    });
}

// Demo Websites functionality
let allDemoWebsites = [];

// Load demo websites
async function loadDemoWebsites() {
    try {
        // Use cached bootstrap data if available
        if (bootstrapCache && bootstrapCache.demoWebsites) {
            allDemoWebsites = bootstrapCache.demoWebsites;
            renderDemoWebsites();
            return;
        }

        const response = await fetch('/api/demo-websites');
        allDemoWebsites = await response.json();
        renderDemoWebsites();
    } catch (error) {
        console.error('Error loading demo websites:', error);
        // If API doesn't exist yet, show empty state
        renderDemoWebsites();
    }
}

// Render demo websites
function renderDemoWebsites() {
    const featuredGrid = document.getElementById('featured-demos-grid');
    const allGrid = document.getElementById('all-demos-grid');
    
    if (!featuredGrid || !allGrid) return;
    
    const featuredDemos = allDemoWebsites.filter(d => d.featured).sort((a, b) => a.sortOrder - b.sortOrder);
    const publishedDemos = allDemoWebsites.filter(d => d.published).sort((a, b) => a.sortOrder - b.sortOrder);
    
    if (featuredDemos.length === 0) {
        featuredGrid.innerHTML = '<p class="no-demos">No featured websites yet.</p>';
    } else {
        featuredGrid.innerHTML = featuredDemos.map(demo => renderDemoCard(demo, true)).join('');
    }
    
    if (publishedDemos.length === 0) {
        allGrid.innerHTML = '<p class="no-demos">No demo websites available yet.</p>';
    } else {
        allGrid.innerHTML = publishedDemos.map(demo => renderDemoCard(demo, false)).join('');
    }
}

// Render single demo card
function renderDemoCard(demo, isFeatured) {
    return `
        <div class="demo-website-card ${isFeatured ? 'featured' : ''}" data-slug="${esc(demo.slug)}" role="button" tabindex="0" onclick="showDemoDetail('${escArg(demo.slug)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();showDemoDetail('${escArg(demo.slug)}');}">
            ${isFeatured ? '<div class="featured-badge-demo">FEATURED</div>' : ''}
            ${demo.status ? `<div class="status-badge">${esc(demo.status)}</div>` : ''}
            ${safeUrl(demo.thumbnail) ? `<img src="${safeUrl(demo.thumbnail)}" alt="${esc(demo.name)}" class="demo-thumbnail" loading="lazy" decoding="async">` : '<div class="demo-thumbnail placeholder" aria-hidden="true"></div>'}
            <div class="demo-info">
                <h3 class="demo-name">${esc(demo.name)}</h3>
                <span class="demo-category" style="font-family: var(--font-accent);">${esc(formatDemoCategory(demo.category))}</span>
                <p class="demo-description">${esc(demo.description)}</p>
                <div class="demo-actions">
                    <a href="${safeUrl(demo.demoUrl) || '#'}" target="_blank" rel="noopener noreferrer" class="view-demo-btn" onclick="event.stopPropagation()">View Demo</a>
                </div>
            </div>
        </div>
    `;
}

// Format demo category for display
function formatDemoCategory(category) {
    const categoryMap = {
        'business': 'Business Website',
        'portfolio': 'Portfolio Website',
        'ecommerce': 'E-commerce Website',
        'restaurant': 'Restaurant Website',
        'realestate': 'Real Estate Website',
        'agency': 'Agency Website',
        'landing': 'Landing Page',
        'education': 'Education Website',
        'healthcare': 'Healthcare Website',
        'other': 'Other'
    };
    // Returns a plain label, not markup. It used to return a wrapped <span>,
    // which meant callers had to inject it unescaped — the styling now lives
    // on the caller's own element instead.
    return categoryMap[category] || category;
}

// Setup demo websites controls
function setupDemoWebsitesControls() {
    // Category filtering
    const categoryBtns = document.querySelectorAll('#demo-category-filters .category-btn');
    categoryBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            categoryBtns.forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            
            const category = this.getAttribute('data-category');
            filterDemoWebsites(category);
        });
    });
    
    // Search functionality
    const searchInput = document.getElementById('demo-search');
    if (searchInput) {
        searchInput.addEventListener('input', function() {
            const searchTerm = this.value.toLowerCase();
            searchDemoWebsites(searchTerm);
        });
    }
}

// Filter demo websites by category
function filterDemoWebsites(category) {
    const allGrid = document.getElementById('all-demos-grid');
    if (!allGrid) return;
    
    let filteredDemos = allDemoWebsites.filter(d => d.published);
    
    if (category !== 'all') {
        filteredDemos = filteredDemos.filter(d => d.category.toLowerCase() === category.toLowerCase());
    }
    
    if (filteredDemos.length === 0) {
        allGrid.innerHTML = '<p class="no-demos">No demo websites found in this category.</p>';
    } else {
        allGrid.innerHTML = filteredDemos.map(demo => renderDemoCard(demo, false)).join('');
    }
}

// Search demo websites
function searchDemoWebsites(searchTerm) {
    const allGrid = document.getElementById('all-demos-grid');
    if (!allGrid) return;
    
    if (!searchTerm) {
        renderDemoWebsites();
        return;
    }
    
    const filteredDemos = allDemoWebsites.filter(demo => {
        return demo.published && (
            demo.name.toLowerCase().includes(searchTerm) ||
            demo.category.toLowerCase().includes(searchTerm) ||
            demo.description.toLowerCase().includes(searchTerm)
        );
    });
    
    if (filteredDemos.length === 0) {
        allGrid.innerHTML = '<p class="no-demos">No demo websites found matching your search.</p>';
    } else {
        allGrid.innerHTML = filteredDemos.map(demo => renderDemoCard(demo, false)).join('');
    }
}

// Demo detail page functionality
function showDemoDetail(slug) {
    const demo = allDemoWebsites.find(d => d.slug === slug && d.published);
    if (!demo) return;
    
    const detailContent = document.getElementById('demo-detail-content');
    detailContent.innerHTML = `
        <div class="demo-detail-header">
            ${demo.status ? `<div class="status-badge">${esc(demo.status)}</div>` : ''}
            <img src="${safeUrl(demo.thumbnail)}" alt="${esc(demo.name)}" class="demo-detail-thumbnail" decoding="async">
        </div>
        <div class="demo-detail-info">
            <h1 class="demo-detail-name">${esc(demo.name)}</h1>
            <div class="demo-detail-meta">
                <span class="demo-detail-category" style="font-family: var(--font-accent);">${esc(formatDemoCategory(demo.category))}</span>
                ${demo.status ? `<span class="demo-detail-status">${esc(demo.status)}</span>` : ''}
            </div>
            <p class="demo-detail-description">${esc(demo.description)}</p>
            <div class="demo-detail-actions">
                <a href="${safeUrl(demo.demoUrl) || '#'}" target="_blank" rel="noopener noreferrer" class="demo-detail-cta">View Live Demo</a>
                <a href="#inquiry" class="demo-detail-cta secondary">Start Your Website</a>
            </div>
        </div>
    `;
    
    // Hide demo websites full section, show detail section
    document.getElementById('demo-websites-full').style.display = 'none';
    document.getElementById('demo-website-detail').style.display = 'block';
    
    // Scroll to top of detail section
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showDemoWebsitesList() {
    // Hide detail section, show demo websites full section
    document.getElementById('demo-website-detail').style.display = 'none';
    document.getElementById('demo-websites-full').style.display = 'block';
    
    // Scroll to top of section
    document.getElementById('demo-websites-full').scrollIntoView({ behavior: 'smooth' });
}

// AI Agents functionality
let allAIAgents = [];

// Load AI agents
async function loadAIAgents() {
    try {
        // Use cached bootstrap data if available
        if (bootstrapCache && bootstrapCache.aiAgents) {
            allAIAgents = bootstrapCache.aiAgents;
            renderAIAgents();
            return;
        }

        const response = await fetch('/api/ai-agents');
        allAIAgents = await response.json();
        renderAIAgents();
    } catch (error) {
        console.error('Error loading AI agents:', error);
        renderAIAgents();
    }
}

// Render AI agents
function renderAIAgents() {
    const featuredGrid = document.getElementById('featured-agents-grid');
    const allGrid = document.getElementById('all-agents-grid');
    
    if (!featuredGrid || !allGrid) return;
    
    const featuredAgents = allAIAgents.filter(a => a.featured).sort((a, b) => a.sortOrder - b.sortOrder);
    const publishedAgents = allAIAgents.filter(a => a.published).sort((a, b) => a.sortOrder - b.sortOrder);
    
    if (featuredAgents.length === 0) {
        featuredGrid.innerHTML = '<p class="no-agents">No featured AI agents yet.</p>';
    } else {
        featuredGrid.innerHTML = featuredAgents.map(agent => renderAgentCard(agent, true)).join('');
    }
    
    if (publishedAgents.length === 0) {
        allGrid.innerHTML = '<p class="no-agents">No AI agents available yet.</p>';
    } else {
        allGrid.innerHTML = publishedAgents.map(agent => renderAgentCard(agent, false)).join('');
    }
}

// Render single AI agent card
function renderAgentCard(agent, isFeatured) {
    return `
        <div class="ai-agent-card ${isFeatured ? 'featured' : ''}" data-slug="${esc(agent.slug)}" role="button" tabindex="0" onclick="showAIAgentDetail('${escArg(agent.slug)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();showAIAgentDetail('${escArg(agent.slug)}');}">
            ${isFeatured ? '<div class="featured-badge-agent">FEATURED</div>' : ''}
            ${agent.status ? `<div class="status-badge-agent">${esc(agent.status)}</div>` : ''}
            ${safeUrl(agent.thumbnail) ? `<img src="${safeUrl(agent.thumbnail)}" alt="${esc(agent.name)}" class="agent-thumbnail" loading="lazy" decoding="async">` : '<div class="agent-thumbnail placeholder" aria-hidden="true"></div>'}
            <div class="agent-info">
                <h3 class="agent-name">${esc(agent.name)}</h3>
                <span class="agent-category">${esc(formatAIAgentCategory(agent.category))}</span>
                <p class="agent-description">${esc(agent.shortDescription)}</p>
                <div class="agent-actions">
                    <a href="${safeUrl(agent.demoUrl) || '#'}" target="_blank" rel="noopener noreferrer" class="try-agent-btn" onclick="event.stopPropagation()">Try Agent</a>
                </div>
            </div>
        </div>
    `;
}

// Format AI agent category for display
function formatAIAgentCategory(category) {
    const categoryMap = {
        'customer-support': 'Customer Support',
        'sales': 'Sales',
        'marketing': 'Marketing',
        'lead-generation': 'Lead Generation',
        'appointment-booking': 'Appointment Booking',
        'whatsapp': 'WhatsApp',
        'ecommerce': 'E-commerce',
        'realestate': 'Real Estate',
        'education': 'Education',
        'hr': 'HR',
        'custom': 'Custom'
    };
    return categoryMap[category] || category;
}

// Setup AI agents controls
function setupAIAgentsControls() {
    // Category filtering
    const categoryBtns = document.querySelectorAll('#ai-agents-category-filters .category-btn');
    categoryBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            categoryBtns.forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            
            const category = this.getAttribute('data-category');
            filterAIAgents(category);
        });
    });
    
    // Search functionality
    const searchInput = document.getElementById('ai-agents-search');
    if (searchInput) {
        searchInput.addEventListener('input', function() {
            const searchTerm = this.value.toLowerCase();
            searchAIAgents(searchTerm);
        });
    }
}

// Filter AI agents by category
function filterAIAgents(category) {
    const allGrid = document.getElementById('all-agents-grid');
    if (!allGrid) return;
    
    let filteredAgents = allAIAgents.filter(a => a.published);
    
    if (category !== 'all') {
        filteredAgents = filteredAgents.filter(a => a.category.toLowerCase() === category.toLowerCase());
    }
    
    if (filteredAgents.length === 0) {
        allGrid.innerHTML = '<p class="no-agents">No AI agents found in this category.</p>';
    } else {
        allGrid.innerHTML = filteredAgents.map(agent => renderAgentCard(agent, false)).join('');
    }
}

// Search AI agents
function searchAIAgents(searchTerm) {
    const allGrid = document.getElementById('all-agents-grid');
    if (!allGrid) return;
    
    if (!searchTerm) {
        renderAIAgents();
        return;
    }
    
    const filteredAgents = allAIAgents.filter(agent => {
        return agent.published && (
            agent.name.toLowerCase().includes(searchTerm) ||
            agent.category.toLowerCase().includes(searchTerm) ||
            agent.shortDescription.toLowerCase().includes(searchTerm) ||
            agent.description.toLowerCase().includes(searchTerm)
        );
    });
    
    if (filteredAgents.length === 0) {
        allGrid.innerHTML = '<p class="no-agents">No AI agents found matching your search.</p>';
    } else {
        allGrid.innerHTML = filteredAgents.map(agent => renderAgentCard(agent, false)).join('');
    }
}

// AI Agent detail page functionality
function showAIAgentDetail(slug) {
    const agent = allAIAgents.find(a => a.slug === slug && a.published);
    if (!agent) return;
    
    const detailContent = document.getElementById('ai-agent-detail-content');
    detailContent.innerHTML = `
        <div class="agent-detail-header">
            ${agent.status ? `<div class="status-badge-agent">${esc(agent.status)}</div>` : ''}
            <img src="${safeUrl(agent.thumbnail)}" alt="${esc(agent.name)}" class="agent-detail-thumbnail" decoding="async">
        </div>
        <div class="agent-detail-info">
            <h1 class="agent-detail-name">${esc(agent.name)}</h1>
            <div class="agent-detail-meta">
                <span class="agent-detail-category">${esc(formatAIAgentCategory(agent.category))}</span>
                ${agent.status ? `<span class="agent-detail-status">${esc(agent.status)}</span>` : ''}
            </div>
            <p class="agent-detail-description">${esc(agent.description)}</p>
            ${asList(agent.features).length ? `<div class="agent-detail-features">
                <h4>Key Features</h4>
                <ul>
                    ${asList(agent.features).map(f => `<li>${esc(f)}</li>`).join('')}
                </ul>
            </div>` : ''}
            ${asList(agent.useCases).length ? `<div class="agent-detail-usecases">
                <h4>Use Cases</h4>
                <ul>
                    ${asList(agent.useCases).map(u => `<li>${esc(u)}</li>`).join('')}
                </ul>
            </div>` : ''}
            <div class="agent-detail-actions">
                <a href="${safeUrl(agent.demoUrl) || '#'}" target="_blank" rel="noopener noreferrer" class="agent-detail-cta">Try AI Agent</a>
                <a href="#inquiry" class="agent-detail-cta secondary">Build Your AI Agent</a>
            </div>
        </div>
    `;
    
    // Hide AI agents demo section, show detail section
    document.getElementById('ai-agents-demo').style.display = 'none';
    document.getElementById('ai-agent-detail').style.display = 'block';
    
    // Scroll to top of detail section
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showAIAgentsList() {
    // Hide detail section, show AI agents demo section
    document.getElementById('ai-agent-detail').style.display = 'none';
    document.getElementById('ai-agents-demo').style.display = 'block';
    
    // Scroll to top of section
    document.getElementById('ai-agents-demo').scrollIntoView({ behavior: 'smooth' });
}