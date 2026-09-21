// PhoenixAI Studio - Admin Dashboard JavaScript

// --- CSRF protection --------------------------------------------------
// The server pairs its httpOnly auth cookie with a second, readable
// "phx_csrf" cookie (double-submit pattern). We patch window.fetch once,
// here, so every admin API call already in this file automatically gets
// the x-csrf-token header — no need to touch each fetch() individually.
(function () {
  function getCookie(name) {
    const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = ((init && init.method) || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    const isAdminApi = url.startsWith('/api/admin/');
    const isMutating = method !== 'GET' && method !== 'HEAD';

    if (isAdminApi && isMutating) {
      const token = getCookie('phx_csrf');
      if (token) {
        init = init || {};
        init.headers = Object.assign({}, init.headers, { 'x-csrf-token': token });
      }
    }
    return originalFetch(input, init);
  };
})();

// Escapes untrusted text before it's inserted into innerHTML.
//
// "Untrusted" here is broader than it looks: notification titles and messages
// are built by the server out of the *public* contact form (visitor name and
// subject), so anything rendered in this panel has to be treated as hostile,
// not just the inquiry/lead tables.
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// For values dropped inside an inline handler, e.g. onclick="f('...')".
// Escapes the JS string first, then the HTML attribute, so neither layer can
// be broken out of.
function escapeArg(value) {
  if (value === null || value === undefined) return '';
  return escapeHtml(String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
}

// For values interpolated into a class name or similar bare attribute token.
// Anything that isn't a safe identifier character is dropped outright.
function escapeToken(value) {
  if (value === null || value === undefined) return '';
  return String(value).toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

let templates = [];
let packages = [];
let inquiries = [];
let leads = [];
let notifications = [];
let demoWebsites = [];
let aiAgents = [];
let services = [];
let modules = [];
let packageCategories = [];
let serviceCategories = [];
let petSettings = { enabled: true, tips: [] };
let petFeatureSettings = { enabled: false };
let editingTemplateId = null;
let editingPackageId = null;
let editingDemoWebsiteId = null;
let editingAIAgentId = null;
let editingModuleId = null;
let editingPackageCategoryId = null;
let editingServiceId = null;
let editingLeadId = null;

// Track currently active section
let currentActiveSection = 'overview';

// Render skeleton sidebar while loading
function renderSkeletonSidebar() {
    const adminNav = document.getElementById('admin-nav');
    if (!adminNav) return;

    adminNav.innerHTML = Array(8).fill(0).map(() => `
        <div class="skeleton-nav-item">
            <div class="skeleton skeleton-icon"></div>
            <div class="skeleton skeleton-text"></div>
        </div>
    `).join('');
}

// Cache functions for sidebar modules
function getCachedModules() {
    try {
        const cached = sessionStorage.getItem('phoenixai:modules');
        if (cached) {
            return JSON.parse(cached);
        }
    } catch (e) {
        // SessionStorage might be disabled or full
        console.warn('Failed to read cached modules:', e);
    }
    return null;
}

function setCachedModules(modulesList) {
    try {
        sessionStorage.setItem('phoenixai:modules', JSON.stringify(modulesList));
    } catch (e) {
        // SessionStorage might be disabled or full
        console.warn('Failed to cache modules:', e);
    }
}

// Load on page load
document.addEventListener('DOMContentLoaded', function() {
    // Render skeleton sidebar immediately
    renderSkeletonSidebar();

    // Try to load sidebar from cache first
    const cachedModules = getCachedModules();
    if (cachedModules) {
        modules = cachedModules;
        renderAdminNavigation();
    }

    loadAdminData();
    setupTemplateForm();
    setupPackageForm();
    setupDemoWebsiteForm();
    setupAIAgentForm();
    setupModuleForm();
    setupPackageCategoryForm();
    setupServiceForm();
    setupLeadForm();
    setupSearch();
    setupPackageCategoryFilters();
    setupServiceCategoryFilters();
    setupLeadsFilters();
    setupInquiriesFilters();
    setupNotificationsFilters();
});

// Load admin data
async function loadAdminData() {
    try {
        // Try bootstrap endpoint first (single request for all data)
        let useBootstrap = false;
        try {
            const bootstrap = await fetchAdminJson('/api/admin/bootstrap');
            templates = bootstrap.templates || [];
            packages = bootstrap.packages || [];
            inquiries = bootstrap.inquiries || [];
            demoWebsites = bootstrap.demoWebsites || [];
            aiAgents = bootstrap.aiAgents || [];
            services = bootstrap.services || [];
            leads = bootstrap.leads || [];
            notifications = bootstrap.notifications || [];
            modules = bootstrap.modules || [];
            packageCategories = bootstrap.packageCategories || [];
            serviceCategories = bootstrap.serviceCategories || [];
            petSettings = bootstrap.pet || { enabled: true, tips: [] };

            // Cache modules for instant sidebar on next visit
            setCachedModules(modules);

            // Render the sidebar right away; the two small pet requests below must not delay it
            renderAdminNavigation();
            updateLogoDisplay(bootstrap.logo);

            // Pet settings are not part of the bootstrap response: load both in parallel
            const [petResult, petFeatureResult] = await Promise.allSettled([
                fetchAdminJson('/api/admin/pet-settings'),
                fetchAdminJson('/api/admin/pet-feature-settings')
            ]);
            if (petResult.status === 'fulfilled') petSettings = petResult.value; // else keep the bootstrap default
            petFeatureSettings = petFeatureResult.status === 'fulfilled' ? petFeatureResult.value : { enabled: false };

            useBootstrap = true;
            console.log('[ADMIN] Loaded data from bootstrap endpoint');
        } catch (bootstrapError) {
            console.log('[ADMIN] Bootstrap endpoint not available, falling back to individual requests');
            // Fall back to individual requests
        }

        if (!useBootstrap) {
            // Step 1: Load settings first (for sidebar navigation)
            const settings = await fetchAdminJson('/api/admin/settings');
            modules = settings.modules || [];
            packageCategories = settings.packageCategories || [];
            serviceCategories = settings.serviceCategories || [];

            // Cache modules for instant sidebar on next visit
            setCachedModules(modules);

            // Render sidebar immediately
            renderAdminNavigation();
            updateLogoDisplay(settings.logo);

            // Step 2: Load all other data in parallel
            const results = await Promise.allSettled([
                fetchAdminJson('/api/admin/templates'),
                fetchAdminJson('/api/admin/packages'),
                fetchAdminJson('/api/admin/inquiries'),
                fetchAdminJson('/api/admin/demo-websites'),
                fetchAdminJson('/api/admin/ai-agents'),
                fetchAdminJson('/api/admin/services'),
                fetchAdminJson('/api/admin/leads'),
                fetchAdminJson('/api/admin/notifications')
            ]);

            // Extract successful results
            if (results[0].status === 'fulfilled') templates = results[0].value;
            if (results[1].status === 'fulfilled') packages = results[1].value;
            if (results[2].status === 'fulfilled') inquiries = results[2].value;
            if (results[3].status === 'fulfilled') demoWebsites = results[3].value;
            if (results[4].status === 'fulfilled') aiAgents = results[4].value;
            if (results[5].status === 'fulfilled') services = results[5].value;
            if (results[6].status === 'fulfilled') leads = results[6].value;
            if (results[7].status === 'fulfilled') notifications = results[7].value;

            // Load pet settings separately
            try {
                petSettings = await fetchAdminJson('/api/admin/pet-settings');
            } catch (e) {
                petSettings = { enabled: true, tips: [] };
            }

            // Load pet feature settings separately
            try {
                petFeatureSettings = await fetchAdminJson('/api/admin/pet-feature-settings');
            } catch (e) {
                petFeatureSettings = { enabled: false };
            }

            // Check for 401 errors
            const has401 = results.some(r =>
                r.status === 'rejected' && r.reason.message.includes('401')
            );
            if (has401) {
                window.location.href = '/admin';
                return;
            }
        }

        // Update UI with all data
        updateStats();
        renderTemplatesTable();
        renderPackagesTable();
        renderDemoWebsitesTable();
        renderAIAgentsTable();
        renderServicesTable();
        renderLeadsTable();
        renderInquiriesTable();
        renderNotificationsTable();
        renderModulesList();
        renderPackageCategoriesList();
        renderServiceCategoriesList();
        populateServiceCategories();
        renderPetSettings();
        renderPetFeatureSettings();
        updateNotificationBadge();

    } catch (error) {
        console.error('Error loading admin data:', error);
        if (error.message.includes('401')) {
            window.location.href = '/admin';
            return;
        }
        showAdminError(error.serverMessage || 'Dashboard data could not be loaded. Please try again.');
    }
}

async function fetchAdminJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        // Keep the server's own explanation (e.g. "Storage is not configured ...") for the error banner.
        let serverMessage = '';
        try { serverMessage = (await response.json()).error || ''; } catch (e) { /* not JSON */ }
        const error = new Error(`${response.status} ${response.statusText} while loading ${url}`);
        error.status = response.status;
        error.serverMessage = serverMessage;
        throw error;
    }
    return response.json();
}

function showAdminError(message) {
    const errorElement = document.getElementById('admin-error');
    if (errorElement) {
        errorElement.textContent = message;
        errorElement.hidden = false;
    }
}

// Setup navigation
function setupNavigation() {
    const navItems = document.querySelectorAll('.admin-nav-item');
    const sections = document.querySelectorAll('.admin-section');
    
    const pageDescriptions = {
        'overview': 'Manage your PhoenixAI Studio content',
        'templates': 'Resume, Portfolio & Cover Letter templates',
        'demo-websites': 'Website demo showcase',
        'ai-agents': 'AI agent services and demos',
        'packages': 'Pricing packages',
        'services': 'Service management',
        'inquiries': 'Contact requests and leads',
        'pet': 'Mascot visibility and tips',
        'settings': 'Application settings and configuration'
    };

    const pageTitles = {
        'overview': 'Admin Dashboard',
        'templates': 'Career Builder',
        'demo-websites': 'Demo Websites',
        'ai-agents': 'AI Agents',
        'packages': 'Packages',
        'services': 'Services',
        'inquiries': 'Inquiries',
        'pet': 'Phoenix Pet',
        'settings': 'Settings'
    };
    
    navItems.forEach(item => {
        item.addEventListener('click', function() {
            const sectionId = this.getAttribute('data-section');

            // Track current active section
            currentActiveSection = sectionId;

            // Update active states
            navItems.forEach(nav => nav.classList.remove('active'));
            this.classList.add('active');

            sections.forEach(section => {
                section.classList.remove('active');
                if (section.id === sectionId) {
                    section.classList.add('active');
                }
            });

            // Update page title and description
            const pageTitle = document.getElementById('page-title');
            const pageDescription = document.getElementById('page-description');
            if (pageTitle && pageTitles[sectionId]) {
                pageTitle.textContent = pageTitles[sectionId];
            }
            if (pageDescription && pageDescriptions[sectionId]) {
                pageDescription.textContent = pageDescriptions[sectionId];
            }
        });
    });
}

// Update statistics
function updateStats() {
    document.getElementById('total-templates').textContent = templates.length;
    document.getElementById('published-templates').textContent = templates.filter(t => t.published).length;
    document.getElementById('total-packages').textContent = packages.length;
    document.getElementById('total-inquiries').textContent = inquiries.length;
    document.getElementById('total-demo-websites').textContent = demoWebsites.length;
    document.getElementById('total-ai-agents').textContent = aiAgents.length;
    document.getElementById('total-services').textContent = services.length;
    document.getElementById('total-leads').textContent = leads.length;
    document.getElementById('unread-notifications').textContent = notifications.filter(n => !n.read).length;

    // Keep the sidebar badge counts (leads / inquiries / notifications) in
    // sync whenever the underlying data changes, not just on first load.
    if (document.getElementById('admin-nav') && document.getElementById('admin-nav').children.length) {
        renderAdminNavigation();
    }
}

// Icon + grouping map for the sidebar. Purely presentational — any module
// id not listed here still renders (with a generic dot icon) so a new
// module added later never disappears from the nav.
const NAV_ICONS = {
    overview: '<circle cx="12" cy="12" r="9"></circle><path d="M12 3v9l6 3"></path>',
    templates: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>',
    'demo-websites': '<rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line>',
    'ai-agents': '<path d="M12 2a10 10 0 1 0 10 10H12V2z"></path><path d="M12 12L2.1 12a10 10 0 0 0 9.9 10"></path><path d="M12 12V2a10 10 0 0 1 10 10"></path>',
    packages: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line>',
    services: '<rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect>',
    leads: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>',
    inquiries: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline>',
    notifications: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path>',
    settings: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>',
    pet: '<path d="M12 2c-1 3-4 4-4 8a4 4 0 0 0 8 0c0-4-3-5-4-8z"></path><path d="M8 16c-2 1-3 3-3 5" ></path><path d="M16 16c2 1 3 3 3 5"></path>'
};

// Section groupings purely for visual organisation in the sidebar —
// doesn't change which modules are enabled, just how they're clustered.
const NAV_GROUPS = [
    { title: null, ids: ['overview'] },
    { title: 'Content', ids: ['templates', 'demo-websites', 'ai-agents', 'packages', 'services'] },
    { title: 'Activity', ids: ['leads', 'inquiries', 'notifications'] },
    { title: 'System', ids: ['settings', 'pet'] }
];

// Modules whose live count is worth a badge in the nav — id -> the count
// already computed by updateStats(). Kept in one place so adding a new
// badge later is a one-line change.
function navBadgeCount(moduleId) {
    switch (moduleId) {
        case 'inquiries': return inquiries.filter(i => i.status === 'New').length;
        case 'leads': return leads.filter(l => l.status === 'New').length;
        case 'notifications': return notifications.filter(n => !n.read).length;
        default: return 0;
    }
}

// Render admin navigation based on modules
function renderAdminNavigation() {
    const adminNav = document.getElementById('admin-nav');
    if (!adminNav) return;

    const enabledModules = modules.filter(m => m.enabled && m.showInSidebar).sort((a, b) => a.displayOrder - b.displayOrder);
    const byId = {};
    enabledModules.forEach(m => { byId[m.id] = m; });

    // Any enabled module not covered by NAV_GROUPS still shows up, in a
    // trailing "More" bucket, so nothing silently disappears from the nav.
    const grouped = new Set();
    NAV_GROUPS.forEach(g => g.ids.forEach(id => grouped.add(id)));
    const leftovers = enabledModules.filter(m => !grouped.has(m.id));
    const groups = leftovers.length
        ? NAV_GROUPS.concat([{ title: 'More', ids: leftovers.map(m => m.id) }])
        : NAV_GROUPS;

    adminNav.innerHTML = groups.map(group => {
        const items = group.ids
            .map(id => byId[id])
            .filter(Boolean)
            .map(module => {
                const icon = NAV_ICONS[module.id] || '<circle cx="12" cy="12" r="3"></circle>';
                const count = navBadgeCount(module.id);
                const badge = count > 0
                    ? `<span class="admin-nav-badge">${count > 99 ? '99+' : count}</span>`
                    : '';
                return `
                    <button class="admin-nav-item ${module.id === currentActiveSection ? 'active' : ''}" data-section="${module.id}">
                        <svg class="admin-nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
                        <span class="admin-nav-label">${escapeHtml(module.navigationLabel)}</span>
                        ${badge}
                    </button>`;
            })
            .join('');
        if (!items) return '';
        const heading = group.title ? `<div class="admin-nav-group-title">${escapeHtml(group.title)}</div>` : '';
        return `<div class="admin-nav-group">${heading}${items}</div>`;
    }).join('');

    // Re-setup navigation after rendering
    setupNavigation();
}

// Render templates table
function renderTemplatesTable() {
    const tbody = document.getElementById('templates-table-body');
    
    if (templates.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No templates yet. Click "Add Template" to create one.</td></tr>';
        return;
    }
    
    tbody.innerHTML = templates.map(template => `
        <tr>
            <td>${escapeHtml(template.name)}</td>
            <td><span style="font-family: var(--font-accent);">${formatCategoryDisplay(template.category)}</span></td>
            <td>${escapeHtml(template.style)}</td>
            <td>${template.featured ? 'Yes' : 'No'}</td>
            <td>
                <button class="action-button publish-toggle ${!template.published ? 'unpublished' : ''}" 
                        onclick="togglePublish('${template.id}')">
                    ${template.published ? 'Published' : 'Draft'}
                </button>
            </td>
            <td>
                <div class="action-buttons">
                    <button class="action-button edit-button" onclick="editTemplate('${template.id}')">Edit</button>
                    <button class="action-button delete-button" onclick="deleteTemplate('${template.id}')">Delete</button>
                </div>
            </td>
        </tr>
    `).join('');
}

// Render packages table
function renderPackagesTable(categoryFilter = 'all') {
    const tbody = document.getElementById('packages-table-body');
    
    const filteredPackages = categoryFilter === 'all' 
        ? packages 
        : packages.filter(pkg => pkg.category === categoryFilter);
    
    if (filteredPackages.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No packages found.</td></tr>';
        return;
    }
    
    tbody.innerHTML = filteredPackages.map(pkg => `
        <tr>
            <td>${escapeHtml(pkg.name)}</td>
            <td><span style="font-family: var(--font-accent);">${formatPackageCategoryDisplay(pkg.category)}</span></td>
            <td>${pkg.currency} ${pkg.price}</td>
            <td>${pkg.billingType}</td>
            <td>
                <button class="action-button publish-toggle ${!pkg.featured ? 'unpublished' : ''}" 
                        onclick="togglePackageFeatured('${pkg.id}')">
                    ${pkg.featured ? 'Featured' : 'Normal'}
                </button>
            </td>
            <td>
                <button class="action-button publish-toggle ${!pkg.published ? 'unpublished' : ''}" 
                        onclick="togglePackagePublish('${pkg.id}')">
                    ${pkg.published ? 'Published' : 'Draft'}
                </button>
            </td>
            <td>${pkg.sortOrder}</td>
            <td>
                <div class="action-buttons">
                    <button class="action-button edit-button" onclick="editPackage('${pkg.id}')">Edit</button>
                    <button class="action-button delete-button" onclick="deletePackage('${pkg.id}')">Delete</button>
                </div>
            </td>
        </tr>
    `).join('');
}

// Format package category for display
function formatPackageCategoryDisplay(category) {
    const categoryMap = {
        'career-builder': 'Career Builder',
        'website-module': 'Website Module',
        'ai-agent-module': 'AI Agent Module'
    };
    return categoryMap[category] || category;
}

// Render inquiries table (simplified version for initial load)
function renderInquiriesTable() {
    const tbody = document.getElementById('inquiries-table-body');
    if (!tbody) return;

    if (inquiries.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No inquiries yet.</td></tr>';
        return;
    }

    tbody.innerHTML = inquiries.map(inquiry => `
        <tr>
            <td>${new Date(inquiry.createdAt).toLocaleDateString()}</td>
            <td>${escapeHtml(inquiry.name)}</td>
            <td>${escapeHtml(inquiry.email)}</td>
            <td>${escapeHtml(inquiry.phone || '-')}</td>
            <td>${escapeHtml(inquiry.service || '-')}</td>
            <td>${escapeHtml(inquiry.budget || '-')}</td>
            <td><span class="status-badge status-${(inquiry.status || 'new').toLowerCase()}">${escapeHtml(inquiry.status || 'New')}</span></td>
            <td>
                <button class="action-button" onclick="viewInquiry('${inquiry.id}')">View</button>
                <button class="action-button" onclick="updateInquiryStatus('${inquiry.id}', 'Contacted')">Contacted</button>
                <button class="action-button" onclick="updateInquiryStatus('${inquiry.id}', 'Completed')">Completed</button>
                <button class="action-button delete-btn" onclick="deleteInquiry('${inquiry.id}')">Delete</button>
            </td>
        </tr>
    `).join('');
}

function renderLeadsTable() {
    const tbody = document.getElementById('leads-table-body');
    if (!tbody) return;

    const searchQuery = (document.getElementById('leads-search')?.value || '').toLowerCase().trim();
    const status = document.getElementById('leads-status-filter')?.value || '';
    const priority = document.getElementById('leads-priority-filter')?.value || '';
    const filteredLeads = leads.filter(lead => {
        const searchable = [lead.name, lead.email, lead.phone, lead.company].join(' ').toLowerCase();
        return (!searchQuery || searchable.includes(searchQuery)) &&
            (!status || lead.status === status) &&
            (!priority || lead.priority === priority);
    });

    if (filteredLeads.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted);">No leads found.</td></tr>';
        return;
    }

    tbody.innerHTML = filteredLeads.map(lead => `
        <tr>
            <td>${escapeHtml(lead.name)}</td>
            <td>${lead.email}</td>
            <td>${lead.phone || '-'}</td>
            <td>${lead.company || '-'}</td>
            <td>${lead.interestedService || '-'}</td>
            <td>${lead.status || 'New'}</td>
            <td>${lead.priority || 'Medium'}</td>
            <td>${lead.createdAt ? new Date(lead.createdAt).toLocaleDateString() : '-'}</td>
            <td>
                <div class="action-buttons">
                    <button class="action-button edit-button" onclick="editLead('${lead.id}')">Edit</button>
                    <button class="action-button delete-button" onclick="deleteLead('${lead.id}')">Delete</button>
                </div>
            </td>
        </tr>
    `).join('');
}

function setupLeadForm() {
    const form = document.getElementById('lead-form');
    if (!form) return;

    form.addEventListener('submit', async function(event) {
        event.preventDefault();
        const leadData = {
            name: document.getElementById('lead-name').value,
            email: document.getElementById('lead-email').value,
            phone: document.getElementById('lead-phone').value,
            company: document.getElementById('lead-company').value,
            interestedService: document.getElementById('lead-service').value,
            source: document.getElementById('lead-source').value,
            status: document.getElementById('lead-status').value,
            priority: document.getElementById('lead-priority').value,
            notes: document.getElementById('lead-notes').value
        };
        const leadId = editingLeadId;

        try {
            const response = await fetch(leadId ? `/api/admin/leads/${leadId}` : '/api/admin/leads', {
                method: leadId ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(leadData)
            });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.error || 'Unable to save lead');
            closeLeadModal();
            await loadAdminData();
        } catch (error) {
            console.error('Error saving lead:', error);
            alert('Error saving lead. Please try again.');
        }
    });
}

function setupLeadsFilters() {
    ['leads-search', 'leads-status-filter', 'leads-priority-filter'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', renderLeadsTable);
        document.getElementById(id)?.addEventListener('change', renderLeadsTable);
    });
}

function setupInquiriesFilters() {}

function setupNotificationsFilters() {
    setupNotificationFilters();
}

function renderNotificationsTable() {
    const tbody = document.getElementById('notifications-table-body');
    if (!tbody) return;

    const type = document.getElementById('notifications-type-filter')?.value || '';
    const readFilter = document.getElementById('notifications-read-filter')?.value || '';
    const filteredNotifications = notifications.filter(notification =>
        (!type || notification.type === type) &&
        (!readFilter || (readFilter === 'read' ? notification.read : !notification.read))
    );

    if (filteredNotifications.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No notifications yet.</td></tr>';
        return;
    }

    tbody.innerHTML = filteredNotifications.map(notification => `
        <tr>
            <td>${escapeHtml(notification.title)}</td>
            <td>${escapeHtml(notification.message)}</td>
            <td>${escapeHtml(notification.type || 'system')}</td>
            <td>${notification.read ? 'Read' : 'Unread'}</td>
            <td>${notification.createdAt ? new Date(notification.createdAt).toLocaleDateString() : '-'}</td>
            <td><button class="action-button edit-button" onclick="markNotificationRead('${escapeArg(notification.id)}')">Mark read</button></td>
        </tr>
    `).join('');
}

function updateNotificationBadge() {
    const badge = document.getElementById('notification-badge');
    if (!badge) return;
    const unreadCount = notifications.filter(notification => !notification.read).length;
    badge.textContent = unreadCount;
    badge.style.display = unreadCount ? 'flex' : 'none';
}

function setupNotificationFilters() {
    ['notifications-type-filter', 'notifications-read-filter'].forEach(id => {
        document.getElementById(id)?.addEventListener('change', renderNotificationsTable);
    });
}

function toggleNotifications() {
    document.getElementById('notification-dropdown')?.classList.toggle('active');
}

function navigateToNotifications() {
    document.querySelector('.admin-nav-item[data-section="notifications"]')?.click();
    document.getElementById('notification-dropdown')?.classList.remove('active');
}

async function markNotificationRead(id) {
    try {
        const response = await fetch(`/api/admin/notifications/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ read: true })
        });
        if (!response.ok) throw new Error(`${response.status} while marking notification read`);
        await loadAdminData();
    } catch (error) {
        console.error('Error marking notification read:', error);
    }
}

async function markAllNotificationsRead() {
    try {
        const response = await fetch('/api/admin/notifications/mark-all-read', { method: 'PUT' });
        if (!response.ok) throw new Error(`${response.status} while marking notifications read`);
        await loadAdminData();
    } catch (error) {
        console.error('Error marking notifications read:', error);
    }
}

function openLeadModal() {
    editingLeadId = null;
    document.getElementById('lead-modal-title').textContent = 'Add Lead';
    document.getElementById('lead-form').reset();
    document.getElementById('lead-id').value = '';
    document.getElementById('lead-modal').classList.add('active');
}

function closeLeadModal() {
    document.getElementById('lead-modal').classList.remove('active');
    editingLeadId = null;
}

function editLead(id) {
    const lead = leads.find(item => item.id === id);
    if (!lead) return;
    editingLeadId = id;
    document.getElementById('lead-modal-title').textContent = 'Edit Lead';
    document.getElementById('lead-id').value = lead.id;
    document.getElementById('lead-name').value = lead.name || '';
    document.getElementById('lead-email').value = lead.email || '';
    document.getElementById('lead-phone').value = lead.phone || '';
    document.getElementById('lead-company').value = lead.company || '';
    document.getElementById('lead-service').value = lead.interestedService || '';
    document.getElementById('lead-source').value = lead.source || 'Website';
    document.getElementById('lead-status').value = lead.status || 'New';
    document.getElementById('lead-priority').value = lead.priority || 'Medium';
    document.getElementById('lead-notes').value = lead.notes || '';
    document.getElementById('lead-modal').classList.add('active');
}

async function deleteLead(id) {
    if (!confirm('Are you sure you want to delete this lead?')) return;
    try {
        const response = await fetch(`/api/admin/leads/${id}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(`${response.status} while deleting lead`);
        await loadAdminData();
    } catch (error) {
        console.error('Error deleting lead:', error);
        alert('Error deleting lead. Please try again.');
    }
}

// Render demo websites table
function renderDemoWebsitesTable() {
    const tbody = document.getElementById('demo-websites-table-body');
    
    if (demoWebsites.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No demo websites yet. Click "Add Demo Website" to create one.</td></tr>';
        return;
    }
    
    tbody.innerHTML = demoWebsites.map(demo => `
        <tr>
            <td>${escapeHtml(demo.name)}</td>
            <td>${formatDemoCategoryDisplay(demo.category)}</td>
            <td>${demo.status || '-'}</td>
            <td>${demo.featured ? 'Yes' : 'No'}</td>
            <td>
                <button class="action-button publish-toggle ${!demo.published ? 'unpublished' : ''}" 
                        onclick="toggleDemoPublish('${demo.id}')">
                    ${demo.published ? 'Published' : 'Draft'}
                </button>
            </td>
            <td>${demo.sortOrder}</td>
            <td>
                <div class="action-buttons">
                    <button class="action-button edit-button" onclick="editDemoWebsite('${demo.id}')">Edit</button>
                    <button class="action-button delete-button" onclick="deleteDemoWebsite('${demo.id}')">Delete</button>
                </div>
            </td>
        </tr>
    `).join('');
}

// Format demo category for display
function formatDemoCategoryDisplay(category) {
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
    return categoryMap[category] || category;
}

// Render AI agents table
function renderAIAgentsTable() {
    const tbody = document.getElementById('ai-agents-table-body');
    
    if (aiAgents.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No AI agents yet. Click "Add AI Agent" to create one.</td></tr>';
        return;
    }
    
    tbody.innerHTML = aiAgents.map(agent => `
        <tr>
            <td>${escapeHtml(agent.name)}</td>
            <td>${formatAIAgentCategoryDisplay(agent.category)}</td>
            <td>${agent.status || '-'}</td>
            <td>${agent.featured ? 'Yes' : 'No'}</td>
            <td>
                <button class="action-button publish-toggle ${!agent.published ? 'unpublished' : ''}" 
                        onclick="toggleAIAgentPublish('${agent.id}')">
                    ${agent.published ? 'Published' : 'Draft'}
                </button>
            </td>
            <td>${agent.sortOrder}</td>
            <td>
                <div class="action-buttons">
                    <button class="action-button edit-button" onclick="editAIAgent('${agent.id}')">Edit</button>
                    <button class="action-button delete-button" onclick="deleteAIAgent('${agent.id}')">Delete</button>
                </div>
            </td>
        </tr>
    `).join('');
}

// Format AI agent category for display
function formatAIAgentCategoryDisplay(category) {
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

// Format category display with accent font
function formatCategoryDisplay(category) {
    const categoryMap = {
        'resume': 'Resume Builder',
        'portfolio': 'Portfolio Builder',
        'cover-letter': 'Cover Letter Builder'
    };
    return categoryMap[category] || category;
}

// Demo Website Modal Functions
function openDemoWebsiteModal() {
    editingDemoWebsiteId = null;
    document.getElementById('demo-modal-title').textContent = 'Add Demo Website';
    document.getElementById('demo-website-form').reset();
    document.getElementById('demo-id').value = '';
    document.getElementById('demo-website-modal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeDemoWebsiteModal() {
    document.getElementById('demo-website-modal').classList.remove('active');
    document.body.style.overflow = 'auto';
    editingDemoWebsiteId = null;
}

function editDemoWebsite(id) {
    const demo = demoWebsites.find(d => d.id === id);
    if (!demo) return;
    
    editingDemoWebsiteId = id;
    document.getElementById('demo-modal-title').textContent = 'Edit Demo Website';
    document.getElementById('demo-id').value = demo.id;
    document.getElementById('demo-name').value = demo.name;
    document.getElementById('demo-slug').value = demo.slug;
    document.getElementById('demo-category').value = demo.category;
    document.getElementById('demo-description').value = demo.description;
    document.getElementById('demo-url').value = demo.demoUrl || '';
    document.getElementById('demo-status').value = demo.status || '';
    document.getElementById('demo-sort-order').value = demo.sortOrder;
    document.getElementById('demo-featured').checked = demo.featured;
    document.getElementById('demo-published').checked = demo.published;
    
    document.getElementById('demo-website-modal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function setupDemoWebsiteForm() {
    const form = document.getElementById('demo-website-form');
    form.addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const formData = new FormData();
        formData.append('name', document.getElementById('demo-name').value);
        formData.append('slug', document.getElementById('demo-slug').value);
        formData.append('category', document.getElementById('demo-category').value);
        formData.append('description', document.getElementById('demo-description').value);
        formData.append('demoUrl', document.getElementById('demo-url').value);
        formData.append('status', document.getElementById('demo-status').value);
        formData.append('sortOrder', document.getElementById('demo-sort-order').value);
        formData.append('featured', document.getElementById('demo-featured').checked);
        formData.append('published', document.getElementById('demo-published').checked);
        
        const thumbnailInput = document.getElementById('demo-thumbnail');
        if (thumbnailInput.files.length > 0) {
            formData.append('thumbnail', thumbnailInput.files[0]);
        }
        
        try {
            const url = editingDemoWebsiteId 
                ? `/api/admin/demo-websites/${editingDemoWebsiteId}`
                : '/api/admin/demo-websites';
            
            const method = editingDemoWebsiteId ? 'PUT' : 'POST';
            
            const response = await fetch(url, {
                method: method,
                body: formData
            });
            
            const data = await response.json();
            
            if (data.success) {
                closeDemoWebsiteModal();
                loadAdminData();
            } else {
                alert('Error saving demo website. Please try again.');
            }
        } catch (error) {
            console.error('Error saving demo website:', error);
            alert('Error saving demo website. Please try again.');
        }
    });
}

async function deleteDemoWebsite(id) {
    if (!confirm('Are you sure you want to delete this demo website?')) return;
    
    try {
        const response = await fetch(`/api/admin/demo-websites/${id}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
            loadAdminData();
        } else {
            alert('Error deleting demo website. Please try again.');
        }
    } catch (error) {
        console.error('Error deleting demo website:', error);
        alert('Error deleting demo website. Please try again.');
    }
}

async function toggleDemoPublish(id) {
    const demo = demoWebsites.find(d => d.id === id);
    if (!demo) return;
    
    try {
        const formData = new FormData();
        formData.append('published', !demo.published);
        
        const response = await fetch(`/api/admin/demo-websites/${id}`, {
            method: 'PUT',
            body: formData
        });
        
        const data = await response.json();
        
        if (data.success) {
            loadAdminData();
        } else {
            alert('Error updating demo website. Please try again.');
        }
    } catch (error) {
        console.error('Error updating demo website:', error);
        alert('Error updating demo website. Please try again.');
    }
}

// AI Agent functions
function openAIAgentModal() {
    editingAIAgentId = null;
    document.getElementById('ai-agent-modal-title').textContent = 'Add AI Agent';
    document.getElementById('ai-agent-form').reset();
    document.getElementById('ai-agent-id').value = '';
    document.getElementById('ai-agent-modal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeAIAgentModal() {
    document.getElementById('ai-agent-modal').classList.remove('active');
    document.body.style.overflow = 'auto';
    editingAIAgentId = null;
}

function editAIAgent(id) {
    const agent = aiAgents.find(a => a.id === id);
    if (!agent) return;
    
    editingAIAgentId = id;
    document.getElementById('ai-agent-modal-title').textContent = 'Edit AI Agent';
    document.getElementById('ai-agent-id').value = agent.id;
    document.getElementById('ai-agent-name').value = agent.name;
    document.getElementById('ai-agent-slug').value = agent.slug;
    document.getElementById('ai-agent-category').value = agent.category;
    document.getElementById('ai-agent-short-description').value = agent.shortDescription;
    document.getElementById('ai-agent-description').value = agent.description;
    document.getElementById('ai-agent-demo-url').value = agent.demoUrl || '';
    document.getElementById('ai-agent-status').value = agent.status || '';
    document.getElementById('ai-agent-features').value = agent.features ? agent.features.join(', ') : '';
    document.getElementById('ai-agent-use-cases').value = agent.useCases ? agent.useCases.join(', ') : '';
    document.getElementById('ai-agent-sort-order').value = agent.sortOrder;
    document.getElementById('ai-agent-featured').checked = agent.featured;
    document.getElementById('ai-agent-published').checked = agent.published;

    document.getElementById('ai-agent-modal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function setupAIAgentForm() {
    const form = document.getElementById('ai-agent-form');
    form.addEventListener('submit', async function(e) {
        e.preventDefault();

        const formData = new FormData();
        formData.append('name', document.getElementById('ai-agent-name').value);
        formData.append('slug', document.getElementById('ai-agent-slug').value);
        formData.append('category', document.getElementById('ai-agent-category').value);
        formData.append('shortDescription', document.getElementById('ai-agent-short-description').value);
        formData.append('description', document.getElementById('ai-agent-description').value);
        formData.append('demoUrl', document.getElementById('ai-agent-demo-url').value);
        formData.append('status', document.getElementById('ai-agent-status').value);
        formData.append('features', JSON.stringify(document.getElementById('ai-agent-features').value.split(',').map(f => f.trim()).filter(f => f)));
        formData.append('useCases', JSON.stringify(document.getElementById('ai-agent-use-cases').value.split(',').map(u => u.trim()).filter(u => u)));
        formData.append('sortOrder', document.getElementById('ai-agent-sort-order').value);
        formData.append('featured', document.getElementById('ai-agent-featured').checked);
        formData.append('published', document.getElementById('ai-agent-published').checked);

        const thumbnailInput = document.getElementById('ai-agent-thumbnail');
        if (thumbnailInput.files.length > 0) {
            formData.append('thumbnail', thumbnailInput.files[0]);
        }

        const url = editingAIAgentId 
            ? `/api/admin/ai-agents/${editingAIAgentId}`
            : '/api/admin/ai-agents';
        
        const method = editingAIAgentId ? 'PUT' : 'POST';

        try {
            const response = await fetch(url, {
                method: method,
                body: formData
            });
            
            const data = await response.json();
            
            if (data.success) {
                closeAIAgentModal();
                loadAdminData();
            } else {
                alert('Error saving AI agent. Please try again.');
            }
        } catch (error) {
            console.error('Error saving AI agent:', error);
            alert('Error saving AI agent. Please try again.');
        }
    });
}

async function deleteAIAgent(id) {
    if (!confirm('Are you sure you want to delete this AI agent?')) return;
    
    try {
        const response = await fetch(`/api/admin/ai-agents/${id}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
            loadAdminData();
        } else {
            alert('Error deleting AI agent. Please try again.');
        }
    } catch (error) {
        console.error('Error deleting AI agent:', error);
        alert('Error deleting AI agent. Please try again.');
    }
}

async function toggleAIAgentPublish(id) {
    const agent = aiAgents.find(a => a.id === id);
    if (!agent) return;
    
    try {
        const formData = new FormData();
        formData.append('published', !agent.published);
        
        const response = await fetch(`/api/admin/ai-agents/${id}`, {
            method: 'PUT',
            body: formData
        });
        
        const data = await response.json();
        
        if (data.success) {
            loadAdminData();
        } else {
            alert('Error updating AI agent. Please try again.');
        }
    } catch (error) {
        console.error('Error updating AI agent:', error);
        alert('Error updating AI agent. Please try again.');
    }
}

// Search functionality
function setupSearch() {
    const searchInput = document.getElementById('admin-search');
    const searchResults = document.getElementById('search-results');
    const searchClear = document.querySelector('.search-clear');
    
    if (!searchInput) return;
    
    // Keyboard shortcut Ctrl+K
    document.addEventListener('keydown', function(e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
            e.preventDefault();
            searchInput.focus();
        }
    });
    
    // Search on input
    searchInput.addEventListener('input', function() {
        const query = this.value.toLowerCase().trim();
        
        if (query.length === 0) {
            searchResults.style.display = 'none';
            searchClear.style.display = 'none';
            return;
        }
        
        searchClear.style.display = 'flex';
        performSearch(query);
    });
    
    // Clear search
    if (searchClear) {
        searchClear.addEventListener('click', function() {
            searchInput.value = '';
            searchResults.style.display = 'none';
            searchClear.style.display = 'none';
        });
    }
    
    // Close search results when clicking outside
    document.addEventListener('click', function(e) {
        if (!searchResults.contains(e.target) && !searchInput.contains(e.target)) {
            searchResults.style.display = 'none';
        }
    });
}

function clearSearch() {
    const searchInput = document.getElementById('admin-search');
    const searchResults = document.getElementById('search-results');
    const searchClear = document.querySelector('.search-clear');
    
    if (searchInput) searchInput.value = '';
    if (searchResults) searchResults.style.display = 'none';
    if (searchClear) searchClear.style.display = 'none';
}

function performSearch(query) {
    const searchResults = document.getElementById('search-results');
    const searchResultsList = document.getElementById('search-results-list');
    
    if (!searchResults || !searchResultsList) return;
    
    const results = [];
    
    // Search modules
    modules.forEach(module => {
        if (module.enabled && (
            module.name.toLowerCase().includes(query) ||
            module.description.toLowerCase().includes(query) ||
            module.navigationLabel.toLowerCase().includes(query)
        )) {
            results.push({
                type: 'module',
                name: module.name,
                category: 'Modules',
                icon: '◉',
                section: module.id
            });
        }
    });
    
    // Search templates
    templates.forEach(template => {
        if (template.name.toLowerCase().includes(query) ||
            template.category.toLowerCase().includes(query) ||
            template.description.toLowerCase().includes(query)) {
            results.push({
                type: 'template',
                name: template.name,
                category: 'Templates',
                icon: '▢',
                section: 'templates'
            });
        }
    });
    
    // Search demo websites
    demoWebsites.forEach(demo => {
        if (demo.name.toLowerCase().includes(query) ||
            demo.category.toLowerCase().includes(query) ||
            demo.description.toLowerCase().includes(query)) {
            results.push({
                type: 'demo',
                name: demo.name,
                category: 'Demo Websites',
                icon: '◈',
                section: 'demo-websites'
            });
        }
    });
    
    // Search AI agents
    aiAgents.forEach(agent => {
        if (agent.name.toLowerCase().includes(query) ||
            agent.category.toLowerCase().includes(query) ||
            agent.shortDescription.toLowerCase().includes(query)) {
            results.push({
                type: 'agent',
                name: agent.name,
                category: 'AI Agents',
                icon: '◇',
                section: 'ai-agents'
            });
        }
    });
    
    // Search packages
    packages.forEach(pkg => {
        if (pkg.name.toLowerCase().includes(query) ||
            pkg.description.toLowerCase().includes(query)) {
            results.push({
                type: 'package',
                name: pkg.name,
                category: 'Packages',
                icon: '▣',
                section: 'packages'
            });
        }
    });

    // Search services
    services.forEach(service => {
        if (service.name.toLowerCase().includes(query) ||
            service.slug.toLowerCase().includes(query) ||
            service.shortDescription.toLowerCase().includes(query)) {
            results.push({
                type: 'service',
                name: service.name,
                category: 'Services',
                icon: '◉',
                section: 'services'
            });
        }
    });

    // Display results
    if (results.length === 0) {
        searchResultsList.innerHTML = '<div class="search-no-results">No results found</div>';
    } else {
        // Group by category
        const grouped = {};
        results.forEach(result => {
            if (!grouped[result.category]) {
                grouped[result.category] = [];
            }
            grouped[result.category].push(result);
        });
        
        let html = '';
        for (const category in grouped) {
            html += `<div class="search-result-group">
                <div class="search-result-group-title">${category}</div>`;
            grouped[category].forEach(result => {
                html += `<div class="search-result-item" onclick="navigateToSection('${result.section}')">
                    <span class="result-icon">${result.icon}</span>
                    <span class="result-label">${result.name}</span>
                    <span class="result-category">${result.type}</span>
                </div>`;
            });
            html += '</div>';
        }
        searchResultsList.innerHTML = html;
    }
    
    searchResults.style.display = 'block';
}

function navigateToSection(sectionId) {
    const navItem = document.querySelector(`.admin-nav-item[data-section="${sectionId}"]`);
    if (navItem) {
        navItem.click();
    }
    clearSearch();
}

// Module Management functions
function renderModulesList() {
    const modulesList = document.getElementById('modules-list');
    if (!modulesList) return;
    
    const sortedModules = [...modules].sort((a, b) => a.displayOrder - b.displayOrder);
    
    if (sortedModules.length === 0) {
        modulesList.innerHTML = '<p class="search-no-results">No modules configured</p>';
        return;
    }
    
    modulesList.innerHTML = sortedModules.map(module => `
        <div class="module-item">
            <div class="module-info">
                <div class="module-name">${escapeHtml(module.name)}</div>
                <div class="module-description">${escapeHtml(module.description)}</div>
                <div class="module-meta">
                    <span class="module-status ${module.enabled ? 'enabled' : 'disabled'}">
                        ${module.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                    <span class="module-order">Order: ${module.displayOrder}</span>
                </div>
            </div>
            <div class="module-actions">
                <button class="module-order-btn" onclick="moveModuleUp('${module.id}')">↑</button>
                <button class="module-order-btn" onclick="moveModuleDown('${module.id}')">↓</button>
                <button class="module-edit-btn" onclick="editModule('${module.id}')">Edit</button>
            </div>
        </div>
    `).join('');
}

function editModule(id) {
    const module = modules.find(m => m.id === id);
    if (!module) return;
    
    editingModuleId = id;
    document.getElementById('module-modal-title').textContent = 'Edit Module';
    document.getElementById('module-id').value = module.id;
    document.getElementById('module-name').value = module.name;
    document.getElementById('module-description').value = module.description;
    document.getElementById('module-navigation-label').value = module.navigationLabel;
    document.getElementById('module-display-order').value = module.displayOrder;
    document.getElementById('module-enabled').checked = module.enabled;
    document.getElementById('module-show-sidebar').checked = module.showInSidebar;
    
    document.getElementById('module-modal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeModuleModal() {
    document.getElementById('module-modal').classList.remove('active');
    document.body.style.overflow = 'auto';
    editingModuleId = null;
}

function setupModuleForm() {
    const form = document.getElementById('module-form');
    form.addEventListener('submit', async function(e) {
        e.preventDefault();

        // Store original values for revert on error
        const originalModule = modules.find(m => m.id === editingModuleId);
        const originalEnabled = document.getElementById('module-enabled').checked;

        const moduleData = {
            name: document.getElementById('module-name').value,
            description: document.getElementById('module-description').value,
            navigationLabel: document.getElementById('module-navigation-label').value,
            displayOrder: parseInt(document.getElementById('module-display-order').value),
            enabled: document.getElementById('module-enabled').checked,
            showInSidebar: document.getElementById('module-show-sidebar').checked
        };

        try {
            const response = await fetch(`/api/admin/modules/${editingModuleId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(moduleData)
            });

            const data = await response.json();

            if (data.success) {
                closeModuleModal();
                loadAdminData();
            } else {
                // Revert the checkbox state
                document.getElementById('module-enabled').checked = originalEnabled;
                showAdminError(data.error || 'Error updating module. Please try again.');
            }
        } catch (error) {
            console.error('Error updating module:', error);
            // Revert the checkbox state
            document.getElementById('module-enabled').checked = originalEnabled;

            // Handle specific error types
            let errorMessage = 'Error updating module. Please try again.';
            if (error.message.includes('503')) {
                errorMessage = 'Storage is not configured. Please set up Upstash Redis in your Vercel project settings.';
            } else if (error.message.includes('500')) {
                errorMessage = 'Server error. Please try again.';
            }
            showAdminError(errorMessage);
        }
    });
}

async function moveModuleUp(id) {
    const sortedModules = [...modules].sort((a, b) => a.displayOrder - b.displayOrder);
    const index = sortedModules.findIndex(m => m.id === id);
    
    if (index <= 0) return;
    
    // Swap with previous
    const temp = sortedModules[index].displayOrder;
    sortedModules[index].displayOrder = sortedModules[index - 1].displayOrder;
    sortedModules[index - 1].displayOrder = temp;
    
    const moduleIds = sortedModules.map(m => m.id);
    
    try {
        const response = await fetch('/api/admin/modules/reorder', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ moduleIds })
        });
        
        const data = await response.json();
        
        if (data.success) {
            loadAdminData();
        } else {
            showAdminError(data.error || 'Error reordering modules. Please try again.');
        }
    } catch (error) {
        console.error('Error reordering modules:', error);
        let errorMessage = 'Error reordering modules. Please try again.';
        if (error.message.includes('503')) {
            errorMessage = 'Storage is not configured. Please set up Upstash Redis in your Vercel project settings.';
        } else if (error.message.includes('500')) {
            errorMessage = 'Server error. Please try again.';
        }
        showAdminError(errorMessage);
    }
}

async function moveModuleDown(id) {
    const sortedModules = [...modules].sort((a, b) => a.displayOrder - b.displayOrder);
    const index = sortedModules.findIndex(m => m.id === id);
    
    if (index >= sortedModules.length - 1) return;
    
    // Swap with next
    const temp = sortedModules[index].displayOrder;
    sortedModules[index].displayOrder = sortedModules[index + 1].displayOrder;
    sortedModules[index + 1].displayOrder = temp;
    
    const moduleIds = sortedModules.map(m => m.id);
    
    try {
        const response = await fetch('/api/admin/modules/reorder', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ moduleIds })
        });
        
        const data = await response.json();
        
        if (data.success) {
            loadAdminData();
        } else {
            showAdminError(data.error || 'Error reordering modules. Please try again.');
        }
    } catch (error) {
        console.error('Error reordering modules:', error);
        let errorMessage = 'Error reordering modules. Please try again.';
        if (error.message.includes('503')) {
            errorMessage = 'Storage is not configured. Please set up Upstash Redis in your Vercel project settings.';
        } else if (error.message.includes('500')) {
            errorMessage = 'Server error. Please try again.';
        }
        showAdminError(errorMessage);
    }
}

// Update logo display
function updateLogoDisplay(logoUrl) {
    if (logoUrl) {
        document.getElementById('admin-logo').src = logoUrl;
        const currentLogo = document.getElementById('current-logo');
        if (currentLogo) {
            currentLogo.src = logoUrl;
        }
    }
}

// Render package categories list
function renderPackageCategoriesList() {
    const categoriesList = document.getElementById('package-categories-list');
    if (!categoriesList) return;
    
    const sortedCategories = [...packageCategories].sort((a, b) => a.displayOrder - b.displayOrder);
    
    if (sortedCategories.length === 0) {
        categoriesList.innerHTML = '<p class="search-no-results">No package categories configured</p>';
        return;
    }
    
    categoriesList.innerHTML = sortedCategories.map(category => `
        <div class="module-item">
            <div class="module-info">
                <div class="module-name">${escapeHtml(category.name)}</div>
                <div class="module-description">${escapeHtml(category.description)}</div>
                <div class="module-meta">
                    <span class="module-status ${category.enabled ? 'enabled' : 'disabled'}">
                        ${category.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                    <span class="module-order">Order: ${category.displayOrder}</span>
                </div>
            </div>
            <div class="module-actions">
                <button class="module-order-btn" onclick="movePackageCategoryUp('${category.id}')">↑</button>
                <button class="module-order-btn" onclick="movePackageCategoryDown('${category.id}')">↓</button>
                <button class="module-edit-btn" onclick="editPackageCategory('${category.id}')">Edit</button>
            </div>
        </div>
    `).join('');
}

// Edit package category
function editPackageCategory(id) {
    const category = packageCategories.find(c => c.id === id);
    if (!category) return;
    
    editingPackageCategoryId = id;
    document.getElementById('package-category-modal-title').textContent = 'Edit Package Category';
    document.getElementById('package-category-id').value = category.id;
    document.getElementById('package-category-name').value = category.name;
    document.getElementById('package-category-description').value = category.description;
    document.getElementById('package-category-display-order').value = category.displayOrder;
    document.getElementById('package-category-enabled').checked = category.enabled;
    
    document.getElementById('package-category-modal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closePackageCategoryModal() {
    document.getElementById('package-category-modal').classList.remove('active');
    document.body.style.overflow = 'auto';
    editingPackageCategoryId = null;
}

// Setup package category form
function setupPackageCategoryForm() {
    const form = document.getElementById('package-category-form');
    form.addEventListener('submit', async function(e) {
        e.preventDefault();

        // Store original values for revert on error
        const originalCategory = packageCategories.find(c => c.id === editingPackageCategoryId);
        const originalEnabled = document.getElementById('package-category-enabled').checked;

        const categoryData = {
            name: document.getElementById('package-category-name').value,
            description: document.getElementById('package-category-description').value,
            displayOrder: parseInt(document.getElementById('package-category-display-order').value),
            enabled: document.getElementById('package-category-enabled').checked
        };

        try {
            const response = await fetch(`/api/admin/package-categories/${editingPackageCategoryId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(categoryData)
            });

            const data = await response.json();

            if (data.success) {
                closePackageCategoryModal();
                loadAdminData();
            } else {
                // Revert the checkbox state
                document.getElementById('package-category-enabled').checked = originalEnabled;
                showAdminError(data.error || 'Error updating package category. Please try again.');
            }
        } catch (error) {
            console.error('Error updating package category:', error);
            // Revert the checkbox state
            document.getElementById('package-category-enabled').checked = originalEnabled;

            // Handle specific error types
            let errorMessage = 'Error updating package category. Please try again.';
            if (error.message.includes('503')) {
                errorMessage = 'Storage is not configured. Please set up Upstash Redis in your Vercel project settings.';
            } else if (error.message.includes('500')) {
                errorMessage = 'Server error. Please try again.';
            }
            showAdminError(errorMessage);
        }
    });
}

// Move package category up
async function movePackageCategoryUp(id) {
    const sortedCategories = [...packageCategories].sort((a, b) => a.displayOrder - b.displayOrder);
    const index = sortedCategories.findIndex(c => c.id === id);
    
    if (index <= 0) return;
    
    // Swap with previous
    const temp = sortedCategories[index].displayOrder;
    sortedCategories[index].displayOrder = sortedCategories[index - 1].displayOrder;
    sortedCategories[index - 1].displayOrder = temp;
    
    const categoryIds = sortedCategories.map(c => c.id);
    
    try {
        const response = await fetch('/api/admin/package-categories/reorder', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ categoryIds })
        });
        
        const data = await response.json();
        
        if (data.success) {
            loadAdminData();
        } else {
            showAdminError(data.error || 'Error reordering package categories. Please try again.');
        }
    } catch (error) {
        console.error('Error reordering package categories:', error);
        let errorMessage = 'Error reordering package categories. Please try again.';
        if (error.message.includes('503')) {
            errorMessage = 'Storage is not configured. Please set up Upstash Redis in your Vercel project settings.';
        } else if (error.message.includes('500')) {
            errorMessage = 'Server error. Please try again.';
        }
        showAdminError(errorMessage);
    }
}

// Move package category down
async function movePackageCategoryDown(id) {
    const sortedCategories = [...packageCategories].sort((a, b) => a.displayOrder - b.displayOrder);
    const index = sortedCategories.findIndex(c => c.id === id);
    
    if (index >= sortedCategories.length - 1) return;
    
    // Swap with next
    const temp = sortedCategories[index].displayOrder;
    sortedCategories[index].displayOrder = sortedCategories[index + 1].displayOrder;
    sortedCategories[index + 1].displayOrder = temp;
    
    const categoryIds = sortedCategories.map(c => c.id);
    
    try {
        const response = await fetch('/api/admin/package-categories/reorder', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ categoryIds })
        });
        
        const data = await response.json();
        
        if (data.success) {
            loadAdminData();
        } else {
            showAdminError(data.error || 'Error reordering package categories. Please try again.');
        }
    } catch (error) {
        console.error('Error reordering package categories:', error);
        let errorMessage = 'Error reordering package categories. Please try again.';
        if (error.message.includes('503')) {
            errorMessage = 'Storage is not configured. Please set up Upstash Redis in your Vercel project settings.';
        } else if (error.message.includes('500')) {
            errorMessage = 'Server error. Please try again.';
        }
        showAdminError(errorMessage);
    }
}

// Setup package category filters
function setupPackageCategoryFilters() {
    const categoryBtns = document.querySelectorAll('#package-category-filters .category-btn');
    categoryBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            categoryBtns.forEach(b => b.classList.remove('active'));
            this.classList.add('active');

            const category = this.getAttribute('data-category');
            renderPackagesTable(category);
        });
    });
}

// Render services table
function renderServicesTable(categoryFilter = 'all', searchQuery = '') {
    const tbody = document.getElementById('services-table-body');

    let filteredServices = services;

    // Apply category filter
    if (categoryFilter !== 'all') {
        filteredServices = filteredServices.filter(s => s.category === categoryFilter);
    }

    // Apply search filter
    if (searchQuery) {
        const query = searchQuery.toLowerCase();
        filteredServices = filteredServices.filter(s =>
            s.name.toLowerCase().includes(query) ||
            s.slug.toLowerCase().includes(query) ||
            s.shortDescription.toLowerCase().includes(query)
        );
    }

    if (filteredServices.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No services found.</td></tr>';
        return;
    }

    tbody.innerHTML = filteredServices.map(service => `
        <tr>
            <td>${escapeHtml(service.name)}</td>
            <td><span style="font-family: var(--font-accent);">${formatServiceCategory(service.category)}</span></td>
            <td>
                <button class="action-button publish-toggle ${!service.active ? 'unpublished' : ''}"
                        onclick="toggleServiceActive('${service.id}')">
                    ${service.active ? 'Active' : 'Inactive'}
                </button>
            </td>
            <td>
                <button class="action-button publish-toggle ${!service.featured ? 'unpublished' : ''}"
                        onclick="toggleServiceFeatured('${service.id}')">
                    ${service.featured ? 'Featured' : 'Normal'}
                </button>
            </td>
            <td>${service.displayOrder}</td>
            <td>
                <div class="action-buttons">
                    <button class="action-button edit-button" onclick="editService('${service.id}')">Edit</button>
                    <button class="action-button delete-button" onclick="deleteService('${service.id}')">Delete</button>
                </div>
            </td>
        </tr>
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

// Filter services
function filterServices() {
    const searchQuery = document.getElementById('service-search').value;
    const activeCategoryBtn = document.querySelector('#service-category-filters .category-btn.active');
    const category = activeCategoryBtn ? activeCategoryBtn.getAttribute('data-category') : 'all';
    renderServicesTable(category, searchQuery);
}

// Setup service category filters
function setupServiceCategoryFilters() {
    const categoryBtns = document.querySelectorAll('#service-category-filters .category-btn');
    categoryBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            categoryBtns.forEach(b => b.classList.remove('active'));
            this.classList.add('active');

            const category = this.getAttribute('data-category');
            const searchQuery = document.getElementById('service-search').value;
            renderServicesTable(category, searchQuery);
        });
    });
}

// Populate service category select and filters from settings
function populateServiceCategories() {
    const categorySelect = document.getElementById('service-category');
    const categoryFilters = document.getElementById('service-category-filters');
    
    if (!categorySelect || !categoryFilters) return;
    
    const enabledCategories = serviceCategories.filter(c => c.enabled).sort((a, b) => a.displayOrder - b.displayOrder);
    
    // Update select options
    const currentValue = categorySelect.value;
    categorySelect.innerHTML = enabledCategories.map(cat =>
        `<option value="${cat.id}">${escapeHtml(cat.name)}</option>`
    ).join('');
    if (currentValue) categorySelect.value = currentValue;
    
    // Update filter buttons
    categoryFilters.innerHTML = '<button class="category-btn active" data-category="all">All Categories</button>' +
        enabledCategories.map(cat =>
            `<button class="category-btn" data-category="${cat.id}">${escapeHtml(cat.name)}</button>`
        ).join('');
    
    // Re-attach event listeners to new filter buttons
    setupServiceCategoryFilters();
}

// Open service modal
function openServiceModal(serviceId = null) {
    const modal = document.getElementById('service-modal');
    const title = document.getElementById('service-modal-title');
    const form = document.getElementById('service-form');

    if (serviceId) {
        editingServiceId = serviceId;
        title.textContent = 'Edit Service';
        const service = services.find(s => s.id === serviceId);

        if (service) {
            document.getElementById('service-id').value = service.id;
            document.getElementById('service-name').value = service.name;
            document.getElementById('service-slug').value = service.slug;
            document.getElementById('service-short-description').value = service.shortDescription;
            document.getElementById('service-description').value = service.description;
            document.getElementById('service-category').value = service.category;
            document.getElementById('service-thumbnail').value = service.thumbnail || '';
            document.getElementById('service-cta-text').value = service.ctaText || 'Learn More';
            document.getElementById('service-cta-link').value = service.ctaLink || '#project-start';
            document.getElementById('service-display-order').value = service.displayOrder;
            document.getElementById('service-active').checked = service.active;
            document.getElementById('service-featured').checked = service.featured;
        }
    } else {
        title.textContent = 'Add Service';
        form.reset();
        editingServiceId = null;
        document.getElementById('service-active').checked = true;
        document.getElementById('service-cta-text').value = 'Learn More';
        document.getElementById('service-cta-link').value = '#project-start';
        document.getElementById('service-display-order').value = services.length + 1;
    }

    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

// Close service modal
function closeServiceModal() {
    document.getElementById('service-modal').classList.remove('active');
    document.body.style.overflow = 'auto';
    editingServiceId = null;
}

// Edit service
function editService(serviceId) {
    openServiceModal(serviceId);
}

// Toggle service active status
async function toggleServiceActive(serviceId) {
    const service = services.find(s => s.id === serviceId);
    if (!service) return;

    service.active = !service.active;

    try {
        const response = await fetch(`/api/admin/services/${serviceId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(service)
        });

        const data = await response.json();

        if (data.success) {
            renderServicesTable();
        } else {
            alert('Error updating service status');
            service.active = !service.active; // Revert
        }
    } catch (error) {
        console.error('Error updating service:', error);
        alert('Error updating service status');
        service.active = !service.active; // Revert
    }
}

// Toggle service featured status
async function toggleServiceFeatured(serviceId) {
    const service = services.find(s => s.id === serviceId);
    if (!service) return;

    service.featured = !service.featured;

    try {
        const response = await fetch(`/api/admin/services/${serviceId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(service)
        });

        const data = await response.json();

        if (data.success) {
            renderServicesTable();
        } else {
            alert('Error updating service featured status');
            service.featured = !service.featured; // Revert
        }
    } catch (error) {
        console.error('Error updating service:', error);
        alert('Error updating service featured status');
        service.featured = !service.featured; // Revert
    }
}

// Delete service
async function deleteService(serviceId) {
    if (!confirm('Are you sure you want to delete this service?')) {
        return;
    }

    try {
        const response = await fetch(`/api/admin/services/${serviceId}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (data.success) {
            loadAdminData();
        } else {
            alert('Error deleting service: ' + (data.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error deleting service:', error);
        alert('Error deleting service');
    }
}

// Setup service form
function setupServiceForm() {
    const form = document.getElementById('service-form');
    form.addEventListener('submit', async function(e) {
        e.preventDefault();

        const serviceData = {
            name: document.getElementById('service-name').value,
            slug: document.getElementById('service-slug').value,
            shortDescription: document.getElementById('service-short-description').value,
            description: document.getElementById('service-description').value,
            category: document.getElementById('service-category').value,
            thumbnail: document.getElementById('service-thumbnail').value,
            ctaText: document.getElementById('service-cta-text').value,
            ctaLink: document.getElementById('service-cta-link').value,
            displayOrder: parseInt(document.getElementById('service-display-order').value),
            active: document.getElementById('service-active').checked,
            featured: document.getElementById('service-featured').checked
        };

        try {
            let response;
            if (editingServiceId) {
                response = await fetch(`/api/admin/services/${editingServiceId}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(serviceData)
                });
            } else {
                response = await fetch('/api/admin/services', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(serviceData)
                });
            }

            const data = await response.json();

            if (data.success) {
                closeServiceModal();
                loadAdminData();
            } else {
                alert('Error saving service: ' + (data.error || 'Unknown error'));
            }
        } catch (error) {
            console.error('Error saving service:', error);
            alert('Error saving service');
        }
    });
}

// Render service categories list
function renderServiceCategoriesList() {
    const categoriesList = document.getElementById('service-categories-list');
    if (!categoriesList) return;

    const sortedCategories = [...serviceCategories].sort((a, b) => a.displayOrder - b.displayOrder);

    if (sortedCategories.length === 0) {
        categoriesList.innerHTML = '<p class="search-no-results">No service categories configured</p>';
        return;
    }

    categoriesList.innerHTML = sortedCategories.map(category => `
        <div class="module-item">
            <div class="module-info">
                <div class="module-name">${escapeHtml(category.name)}</div>
                <div class="module-description">${escapeHtml(category.description)}</div>
                <div class="module-meta">
                    <span class="module-status ${category.enabled ? 'enabled' : 'disabled'}">
                        ${category.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                    <span class="module-order">Order: ${category.displayOrder}</span>
                </div>
            </div>
            <div class="module-actions">
                <button class="module-order-btn" onclick="moveServiceCategoryUp('${category.id}')">↑</button>
                <button class="module-order-btn" onclick="moveServiceCategoryDown('${category.id}')">↓</button>
                <button class="module-edit-btn" onclick="editServiceCategory('${category.id}')">Edit</button>
            </div>
        </div>
    `).join('');
}

// Edit service category
function editServiceCategory(id) {
    const category = serviceCategories.find(c => c.id === id);
    if (!category) return;

    // For now, just alert - can be extended to full modal editing
    alert(`Edit category: ${category.name}\nDescription: ${category.description}\nEnabled: ${category.enabled}\nOrder: ${category.displayOrder}`);
}

// Move service category up
async function moveServiceCategoryUp(id) {
    const sortedCategories = [...serviceCategories].sort((a, b) => a.displayOrder - b.displayOrder);
    const index = sortedCategories.findIndex(c => c.id === id);

    if (index <= 0) return;

    const temp = sortedCategories[index].displayOrder;
    sortedCategories[index].displayOrder = sortedCategories[index - 1].displayOrder;
    sortedCategories[index - 1].displayOrder = temp;

    const categoryIds = sortedCategories.map(c => c.id);

    try {
        const response = await fetch('/api/admin/service-categories/reorder', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ categoryIds })
        });

        const data = await response.json();

        if (data.success) {
            loadAdminData();
        } else {
            showAdminError(data.error || 'Error reordering service categories. Please try again.');
        }
    } catch (error) {
        console.error('Error reordering service categories:', error);
        let errorMessage = 'Error reordering service categories. Please try again.';
        if (error.message.includes('503')) {
            errorMessage = 'Storage is not configured. Please set up Upstash Redis in your Vercel project settings.';
        } else if (error.message.includes('500')) {
            errorMessage = 'Server error. Please try again.';
        }
        showAdminError(errorMessage);
    }
}

// Move service category down
async function moveServiceCategoryDown(id) {
    const sortedCategories = [...serviceCategories].sort((a, b) => a.displayOrder - b.displayOrder);
    const index = sortedCategories.findIndex(c => c.id === id);

    if (index >= sortedCategories.length - 1) return;

    const temp = sortedCategories[index].displayOrder;
    sortedCategories[index].displayOrder = sortedCategories[index + 1].displayOrder;
    sortedCategories[index + 1].displayOrder = temp;

    const categoryIds = sortedCategories.map(c => c.id);

    try {
        const response = await fetch('/api/admin/service-categories/reorder', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ categoryIds })
        });

        const data = await response.json();

        if (data.success) {
            loadAdminData();
        } else {
            showAdminError(data.error || 'Error reordering service categories. Please try again.');
        }
    } catch (error) {
        console.error('Error reordering service categories:', error);
        let errorMessage = 'Error reordering service categories. Please try again.';
        if (error.message.includes('503')) {
            errorMessage = 'Storage is not configured. Please set up Upstash Redis in your Vercel project settings.';
        } else if (error.message.includes('500')) {
            errorMessage = 'Server error. Please try again.';
        }
        showAdminError(errorMessage);
    }
}

// Setup template form
function setupTemplateForm() {
    document.getElementById('template-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        
        const formData = new FormData();
        formData.append('name', document.getElementById('template-name').value);
        formData.append('category', document.getElementById('template-category').value);
        formData.append('description', document.getElementById('template-description').value);
        formData.append('style', document.getElementById('template-style').value);
        formData.append('portfolioUrl', document.getElementById('template-portfolio-url').value);
        formData.append('sortOrder', document.getElementById('template-sort-order').value);
        formData.append('featured', document.getElementById('template-featured').checked);
        formData.append('published', document.getElementById('template-published').checked);
        
        // Add files if present
        const thumbnail = document.getElementById('template-thumbnail').files[0];
        const pdf = document.getElementById('template-pdf').files[0];
        const previewImages = document.getElementById('template-preview-images').files;
        
        if (thumbnail) formData.append('thumbnail', thumbnail);
        if (pdf) formData.append('pdf', pdf);
        if (previewImages.length > 0) {
            for (let i = 0; i < previewImages.length; i++) {
                formData.append('previewImages', previewImages[i]);
            }
        }
        
        try {
            let response;
            if (editingTemplateId) {
                response = await fetch(`/api/admin/templates/${editingTemplateId}`, {
                    method: 'PUT',
                    body: formData
                });
            } else {
                response = await fetch('/api/admin/templates', {
                    method: 'POST',
                    body: formData
                });
            }
            
            const data = await response.json();
            
            if (data.success) {
                closeTemplateModal();
                loadAdminData();
            } else {
                alert('Error saving template: ' + (data.error || 'Unknown error'));
            }
        } catch (error) {
            console.error('Error saving template:', error);
            alert('Error saving template. Please try again.');
        }
    });
}

// Open template modal
function openTemplateModal(templateId = null) {
    editingTemplateId = templateId;
    const modal = document.getElementById('template-modal');
    const title = document.getElementById('modal-title');
    const form = document.getElementById('template-form');
    
    if (templateId) {
        title.textContent = 'Edit Template';
        const template = templates.find(t => t.id === templateId);
        
        if (template) {
            document.getElementById('template-name').value = template.name;
            document.getElementById('template-category').value = template.category;
            document.getElementById('template-description').value = template.description;
            document.getElementById('template-style').value = template.style;
            document.getElementById('template-portfolio-url').value = template.portfolioUrl || '';
            document.getElementById('template-sort-order').value = template.sortOrder || 0;
            document.getElementById('template-featured').checked = template.featured;
            document.getElementById('template-published').checked = template.published;
            
            // Remove required from file inputs when editing
            document.getElementById('template-thumbnail').required = false;
        }
    } else {
        title.textContent = 'Add Template';
        form.reset();
        document.getElementById('template-published').checked = true;
        document.getElementById('template-thumbnail').required = true;
    }
    
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

// Close template modal
function closeTemplateModal() {
    document.getElementById('template-modal').classList.remove('active');
    document.body.style.overflow = 'auto';
    editingTemplateId = null;
    document.getElementById('template-form').reset();
}

// Edit template
function editTemplate(templateId) {
    openTemplateModal(templateId);
}

// Delete template
async function deleteTemplate(templateId) {
    if (!confirm('Are you sure you want to delete this template?')) {
        return;
    }
    
    try {
        const response = await fetch(`/api/admin/templates/${templateId}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
            loadAdminData();
        } else {
            alert('Error deleting template: ' + (data.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error deleting template:', error);
        alert('Error deleting template. Please try again.');
    }
}

// Toggle publish status
async function togglePublish(templateId) {
    try {
        const template = templates.find(t => t.id === templateId);
        if (!template) return;
        
        const formData = new FormData();
        formData.append('name', template.name);
        formData.append('category', template.category);
        formData.append('description', template.description);
        formData.append('style', template.style);
        formData.append('portfolioUrl', template.portfolioUrl || '');
        formData.append('sortOrder', template.sortOrder || 0);
        formData.append('featured', template.featured);
        formData.append('published', !template.published);
        
        const response = await fetch(`/api/admin/templates/${templateId}`, {
            method: 'PUT',
            body: formData
        });
        
        const data = await response.json();
        
        if (data.success) {
            loadAdminData();
        } else {
            alert('Error updating template: ' + (data.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error updating template:', error);
        alert('Error updating template. Please try again.');
    }
}

// Upload logo
async function uploadLogo() {
    const logoFile = document.getElementById('logo-upload').files[0];
    
    if (!logoFile) {
        alert('Please select a logo file to upload.');
        return;
    }
    
    const formData = new FormData();
    formData.append('logo', logoFile);
    
    try {
        const response = await fetch('/api/admin/settings/logo', {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        if (data.success) {
            updateLogoDisplay(data.logo);
            alert('Logo updated successfully!');
        } else {
            alert('Error uploading logo: ' + (data.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error uploading logo:', error);
        alert('Error uploading logo. Please try again.');
    }
}

// Change admin password
// Render Phoenix Pet settings into the form
function renderPetSettings() {
    const toggle = document.getElementById('pet-enabled-toggle');
    const label = document.getElementById('pet-toggle-label');
    const textarea = document.getElementById('pet-tips-textarea');
    if (!toggle || !textarea) return;

    toggle.checked = petSettings.enabled !== false;
    label.textContent = toggle.checked
        ? 'Mascot is enabled on the website'
        : 'Mascot is hidden on the website';
    textarea.value = (petSettings.tips || []).join('\n');

    toggle.onchange = function () {
        label.textContent = toggle.checked
            ? 'Mascot is enabled on the website'
            : 'Mascot is hidden on the website';
    };
}

// Save Phoenix Pet settings
async function savePetSettings() {
    const toggle = document.getElementById('pet-enabled-toggle');
    const textarea = document.getElementById('pet-tips-textarea');
    const msgEl = document.getElementById('pet-settings-message');

    const tips = textarea.value
        .split('\n')
        .map(t => t.trim())
        .filter(Boolean);

    if (tips.length === 0) {
        msgEl.textContent = 'Add at least one tip.';
        msgEl.style.color = '#FF6A00';
        return;
    }

    try {
        const response = await fetch('/api/admin/pet-settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: toggle.checked, tips })
        });
        const data = await response.json();

        if (data.success) {
            petSettings = data.pet;
            msgEl.textContent = 'Pet settings saved.';
            msgEl.style.color = '#4CAF50';
        } else {
            msgEl.textContent = data.error || 'Error saving pet settings.';
            msgEl.style.color = '#FF6A00';
        }
    } catch (error) {
        console.error('Error saving pet settings:', error);
        msgEl.textContent = 'Error saving pet settings. Please try again.';
        msgEl.style.color = '#FF6A00';
    }
}

// PET Feature Settings Functions
function renderPetFeatureSettings() {
    const toggle = document.getElementById('pet-feature-toggle');
    const label = document.getElementById('pet-feature-toggle-label');

    if (toggle && label) {
        toggle.checked = petFeatureSettings.enabled === true;
        label.textContent = petFeatureSettings.enabled ? 'PET is enabled' : 'PET is disabled';
    }
}

async function savePetFeatureSettings() {
    const toggle = document.getElementById('pet-feature-toggle');
    const msgEl = document.getElementById('pet-feature-settings-message');

    if (!toggle) return;

    msgEl.style.color = '#D4D4D4';

    try {
        const response = await fetch('/api/admin/pet-feature-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: toggle.checked })
        });

        const data = await response.json();

        if (data.success) {
            petFeatureSettings.enabled = toggle.checked;
            const label = document.getElementById('pet-feature-toggle-label');
            label.textContent = toggle.checked ? 'PET is enabled' : 'PET is disabled';
            msgEl.textContent = 'PET feature settings saved.';
            msgEl.style.color = '#4CAF50';
        } else {
            msgEl.textContent = data.error || 'Error saving PET feature settings.';
            msgEl.style.color = '#FF6A00';
        }
    } catch (error) {
        console.error('Error saving PET feature settings:', error);
        msgEl.textContent = 'Error saving PET feature settings. Please try again.';
        msgEl.style.color = '#FF6A00';
    }
}

async function changeAdminPassword() {
    const currentPassword = document.getElementById('current-password').value;
    const newPassword = document.getElementById('new-password').value;
    const confirmPassword = document.getElementById('confirm-password').value;
    const msgEl = document.getElementById('password-change-message');

    msgEl.style.color = '#D4D4D4';

    if (!currentPassword || !newPassword || !confirmPassword) {
        msgEl.textContent = 'Please fill in all password fields.';
        msgEl.style.color = '#FF6A00';
        return;
    }

    if (newPassword.length < 8) {
        msgEl.textContent = 'New password must be at least 8 characters.';
        msgEl.style.color = '#FF6A00';
        return;
    }

    if (newPassword !== confirmPassword) {
        msgEl.textContent = 'New password and confirmation do not match.';
        msgEl.style.color = '#FF6A00';
        return;
    }

    try {
        const response = await fetch('/api/admin/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword, newPassword })
        });

        const data = await response.json();

        if (data.success) {
            msgEl.textContent = 'Password updated successfully.';
            msgEl.style.color = '#4CAF50';
            document.getElementById('current-password').value = '';
            document.getElementById('new-password').value = '';
            document.getElementById('confirm-password').value = '';
        } else {
            msgEl.textContent = data.error || 'Error updating password.';
            msgEl.style.color = '#FF6A00';
        }
    } catch (error) {
        console.error('Error changing password:', error);
        msgEl.textContent = 'Error updating password. Please try again.';
        msgEl.style.color = '#FF6A00';
    }
}

// Logout
async function logout() {
    try {
        await fetch('/api/admin/logout', {
            method: 'POST'
        });
        window.location.href = '/admin';
    } catch (error) {
        console.error('Error logging out:', error);
        window.location.href = '/admin';
    }
}

// Close modal on escape key
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        closeTemplateModal();
    }
});

// Close modal on background click
document.getElementById('template-modal').addEventListener('click', function(e) {
    if (e.target === this) {
        closeTemplateModal();
    }
});

// Setup package form
function setupPackageForm() {
    document.getElementById('package-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        
        // Collect features
        const featureInputs = document.querySelectorAll('.feature-input');
        const features = Array.from(featureInputs)
            .map(input => input.value.trim())
            .filter(value => value !== '');
        
        const packageData = {
            name: document.getElementById('package-name').value,
            slug: document.getElementById('package-slug').value,
            category: document.getElementById('package-category').value,
            price: document.getElementById('package-price').value,
            currency: document.getElementById('package-currency').value,
            billingType: document.getElementById('package-billing-type').value,
            description: document.getElementById('package-description').value,
            features: features,
            ctaText: document.getElementById('package-cta-text').value,
            ctaLink: document.getElementById('package-cta-link').value,
            sortOrder: document.getElementById('package-sort-order').value,
            featured: document.getElementById('package-featured').checked,
            published: document.getElementById('package-published').checked
        };
        
        try {
            let response;
            if (editingPackageId) {
                response = await fetch(`/api/admin/packages/${editingPackageId}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(packageData)
                });
            } else {
                response = await fetch('/api/admin/packages', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(packageData)
                });
            }
            
            const data = await response.json();
            
            if (data.success) {
                closePackageModal();
                loadAdminData();
            } else {
                alert('Error saving package: ' + (data.error || 'Unknown error'));
            }
        } catch (error) {
            console.error('Error saving package:', error);
            alert('Error saving package. Please try again.');
        }
    });
}

// Open package modal
function openPackageModal(packageId = null) {
    editingPackageId = packageId;
    const modal = document.getElementById('package-modal');
    const title = document.getElementById('package-modal-title');
    const form = document.getElementById('package-form');
    
    if (packageId) {
        title.textContent = 'Edit Package';
        const pkg = packages.find(p => p.id === packageId);
        
        if (pkg) {
            document.getElementById('package-name').value = pkg.name;
            document.getElementById('package-slug').value = pkg.slug;
            document.getElementById('package-price').value = pkg.price;
            document.getElementById('package-currency').value = pkg.currency;
            document.getElementById('package-billing-type').value = pkg.billingType;
            document.getElementById('package-description').value = pkg.description;
            document.getElementById('package-cta-text').value = pkg.ctaText;
            document.getElementById('package-cta-link').value = pkg.ctaLink;
            document.getElementById('package-category').value = pkg.category || 'website-module';
            document.getElementById('package-sort-order').value = pkg.sortOrder;
            document.getElementById('package-featured').checked = pkg.featured;
            document.getElementById('package-published').checked = pkg.published;
            
            // Load features
            const featuresContainer = document.getElementById('package-features-container');
            featuresContainer.innerHTML = '';
            
            if (pkg.features && pkg.features.length > 0) {
                pkg.features.forEach(feature => {
                    addFeature(feature);
                });
            } else {
                addFeature();
            }
        }
    } else {
        title.textContent = 'Add Package';
        form.reset();
        document.getElementById('package-published').checked = true;
        document.getElementById('package-cta-text').value = 'Get Started';
        document.getElementById('package-cta-link').value = '#project-start';
        
        // Reset features
        const featuresContainer = document.getElementById('package-features-container');
        featuresContainer.innerHTML = '';
        addFeature();
    }
    
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

// Close package modal
function closePackageModal() {
    document.getElementById('package-modal').classList.remove('active');
    document.body.style.overflow = 'auto';
    editingPackageId = null;
    document.getElementById('package-form').reset();
}

// Edit package
function editPackage(packageId) {
    openPackageModal(packageId);
}

// Delete package
async function deletePackage(packageId) {
    if (!confirm('Are you sure you want to delete this package?')) {
        return;
    }
    
    try {
        const response = await fetch(`/api/admin/packages/${packageId}`, {
            method: 'DELETE'
        });
        
        const data = await response.json();
        
        if (data.success) {
            loadAdminData();
        } else {
            alert('Error deleting package: ' + (data.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error deleting package:', error);
        alert('Error deleting package. Please try again.');
    }
}

// Toggle package featured status
async function togglePackageFeatured(packageId) {
    try {
        const pkg = packages.find(p => p.id === packageId);
        if (!pkg) return;
        
        const packageData = {
            name: pkg.name,
            slug: pkg.slug,
            price: pkg.price,
            currency: pkg.currency,
            billingType: pkg.billingType,
            description: pkg.description,
            features: pkg.features,
            ctaText: pkg.ctaText,
            ctaLink: pkg.ctaLink,
            sortOrder: pkg.sortOrder,
            featured: !pkg.featured,
            published: pkg.published
        };
        
        const response = await fetch(`/api/admin/packages/${packageId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(packageData)
        });
        
        const data = await response.json();
        
        if (data.success) {
            loadAdminData();
        } else {
            alert('Error updating package: ' + (data.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error updating package:', error);
        alert('Error updating package. Please try again.');
    }
}

// Toggle package publish status
async function togglePackagePublish(packageId) {
    try {
        const pkg = packages.find(p => p.id === packageId);
        if (!pkg) return;
        
        const packageData = {
            name: pkg.name,
            slug: pkg.slug,
            price: pkg.price,
            currency: pkg.currency,
            billingType: pkg.billingType,
            description: pkg.description,
            features: pkg.features,
            ctaText: pkg.ctaText,
            ctaLink: pkg.ctaLink,
            sortOrder: pkg.sortOrder,
            featured: pkg.featured,
            published: !pkg.published
        };
        
        const response = await fetch(`/api/admin/packages/${packageId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(packageData)
        });
        
        const data = await response.json();
        
        if (data.success) {
            loadAdminData();
        } else {
            alert('Error updating package: ' + (data.error || 'Unknown error'));
        }
    } catch (error) {
        console.error('Error updating package:', error);
        alert('Error updating package. Please try again.');
    }
}

// Add feature input
function addFeature(value = '') {
    const featuresContainer = document.getElementById('package-features-container');
    const featureItem = document.createElement('div');
    featureItem.className = 'feature-item';
    featureItem.innerHTML = `
        <input type="text" class="feature-input" placeholder="Enter feature" value="${value}">
        <button type="button" class="remove-feature-button" onclick="removeFeature(this)">Remove</button>
    `;
    featuresContainer.appendChild(featureItem);
}

// Remove feature input
function removeFeature(button) {
    const featuresContainer = document.getElementById('package-features-container');
    const featureItems = featuresContainer.querySelectorAll('.feature-item');
    
    if (featureItems.length > 1) {
        button.parentElement.remove();
    } else {
        alert('At least one feature is required');
    }
}

// Close package modal on escape key
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        closePackageModal();
    }
});

// Close package modal on background click
document.getElementById('package-modal').addEventListener('click', function(e) {
    if (e.target === this) {
        closePackageModal();
    }
});

// =========================================================
// LEADS MODULE
// =========================================================

function renderLeadsTable() {
    const tbody = document.getElementById('leads-table-body');
    if (!tbody) return;

    const searchTerm = document.getElementById('leads-search')?.value.toLowerCase() || '';
    const statusFilter = document.getElementById('leads-status-filter')?.value || '';
    const priorityFilter = document.getElementById('leads-priority-filter')?.value || '';

    let filteredLeads = leads.filter(lead => {
        const matchesSearch = 
            lead.name?.toLowerCase().includes(searchTerm) ||
            lead.email?.toLowerCase().includes(searchTerm) ||
            lead.phone?.toLowerCase().includes(searchTerm) ||
            lead.company?.toLowerCase().includes(searchTerm);
        
        const matchesStatus = !statusFilter || lead.status === statusFilter;
        const matchesPriority = !priorityFilter || lead.priority === priorityFilter;

        return matchesSearch && matchesStatus && matchesPriority;
    });

    if (filteredLeads.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted);">No leads found.</td></tr>';
        return;
    }

    tbody.innerHTML = filteredLeads.map(lead => `
        <tr>
            <td>${escapeHtml(lead.name)}</td>
            <td>${escapeHtml(lead.email)}</td>
            <td>${escapeHtml(lead.phone) || '-'}</td>
            <td>${escapeHtml(lead.company) || '-'}</td>
            <td>${escapeHtml(lead.interestedService) || '-'}</td>
            <td><span class="status-badge status-${lead.status?.toLowerCase()}">${escapeHtml(lead.status)}</span></td>
            <td><span class="priority-badge priority-${lead.priority?.toLowerCase()}">${escapeHtml(lead.priority)}</span></td>
            <td>${new Date(lead.createdAt).toLocaleDateString()}</td>
            <td>
                <button class="action-button" onclick="editLead('${lead.id}')">Edit</button>
                <button class="action-button delete" onclick="deleteLead('${lead.id}')">Delete</button>
            </td>
        </tr>
    `).join('');
}

function openLeadModal() {
    editingLeadId = null;
    document.getElementById('lead-modal-title').textContent = 'Add Lead';
    document.getElementById('lead-form').reset();
    document.getElementById('lead-id').value = '';
    document.getElementById('lead-modal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeLeadModal() {
    document.getElementById('lead-modal').classList.remove('active');
    document.body.style.overflow = 'auto';
    editingLeadId = null;
}

function editLead(id) {
    const lead = leads.find(l => l.id === id);
    if (!lead) return;

    editingLeadId = id;
    document.getElementById('lead-modal-title').textContent = 'Edit Lead';
    document.getElementById('lead-id').value = lead.id;
    document.getElementById('lead-name').value = lead.name;
    document.getElementById('lead-email').value = lead.email;
    document.getElementById('lead-phone').value = lead.phone || '';
    document.getElementById('lead-company').value = lead.company || '';
    document.getElementById('lead-service').value = lead.interestedService || '';
    document.getElementById('lead-source').value = lead.source || 'Website';
    document.getElementById('lead-status').value = lead.status || 'New';
    document.getElementById('lead-priority').value = lead.priority || 'Medium';
    document.getElementById('lead-notes').value = lead.notes || '';

    document.getElementById('lead-modal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function setupLeadForm() {
    const form = document.getElementById('lead-form');
    form.addEventListener('submit', async function(e) {
        e.preventDefault();

        const leadData = {
            name: document.getElementById('lead-name').value,
            email: document.getElementById('lead-email').value,
            phone: document.getElementById('lead-phone').value,
            company: document.getElementById('lead-company').value,
            interestedService: document.getElementById('lead-service').value,
            source: document.getElementById('lead-source').value,
            status: document.getElementById('lead-status').value,
            priority: document.getElementById('lead-priority').value,
            notes: document.getElementById('lead-notes').value
        };

        try {
            let response;
            if (editingLeadId) {
                response = await fetch(`/api/admin/leads/${editingLeadId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(leadData)
                });
            } else {
                response = await fetch('/api/admin/leads', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(leadData)
                });
            }

            const data = await response.json();

            if (data.success) {
                closeLeadModal();
                loadAdminData();
            } else {
                alert('Error saving lead. Please try again.');
            }
        } catch (error) {
            console.error('Error saving lead:', error);
            alert('Error saving lead. Please try again.');
        }
    });
}

async function deleteLead(id) {
    if (!confirm('Are you sure you want to delete this lead?')) return;

    try {
        const response = await fetch(`/api/admin/leads/${id}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (data.success) {
            loadAdminData();
        } else {
            alert('Error deleting lead. Please try again.');
        }
    } catch (error) {
        console.error('Error deleting lead:', error);
        alert('Error deleting lead. Please try again.');
    }
}

function setupLeadsFilters() {
    const searchInput = document.getElementById('leads-search');
    const statusFilter = document.getElementById('leads-status-filter');
    const priorityFilter = document.getElementById('leads-priority-filter');

    if (searchInput) searchInput.addEventListener('input', renderLeadsTable);
    if (statusFilter) statusFilter.addEventListener('change', renderLeadsTable);
    if (priorityFilter) priorityFilter.addEventListener('change', renderLeadsTable);
}

// =========================================================
// CONTACT REQUESTS MODULE
// =========================================================

function renderInquiriesTable() {
    const tbody = document.getElementById('inquiries-table-body');
    if (!tbody) return;

    const searchTerm = document.getElementById('inquiries-search')?.value.toLowerCase() || '';
    const statusFilter = document.getElementById('inquiries-status-filter')?.value || '';

    let filteredInquiries = inquiries.filter(inquiry => {
        const matchesSearch =
            inquiry.name?.toLowerCase().includes(searchTerm) ||
            inquiry.email?.toLowerCase().includes(searchTerm) ||
            inquiry.subject?.toLowerCase().includes(searchTerm) ||
            inquiry.service?.toLowerCase().includes(searchTerm);

        const matchesStatus = !statusFilter || inquiry.status === statusFilter;

        return matchesSearch && matchesStatus;
    });

    if (filteredInquiries.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No contact requests found.</td></tr>';
        return;
    }

    tbody.innerHTML = filteredInquiries.map(inquiry => `
        <tr>
            <td>${new Date(inquiry.createdAt).toLocaleDateString()}</td>
            <td>${escapeHtml(inquiry.name)}</td>
            <td>${escapeHtml(inquiry.email)}</td>
            <td>${escapeHtml(inquiry.phone || '-')}</td>
            <td>${escapeHtml(inquiry.service || '-')}</td>
            <td>${escapeHtml(inquiry.budget || '-')}</td>
            <td><span class="status-badge status-${(inquiry.status || 'new').toLowerCase()}">${escapeHtml(inquiry.status || 'New')}</span></td>
            <td>
                <button class="action-button" onclick="viewInquiry('${inquiry.id}')">View</button>
                <button class="action-button" onclick="updateInquiryStatus('${inquiry.id}', 'Contacted')">Contacted</button>
                <button class="action-button" onclick="updateInquiryStatus('${inquiry.id}', 'Completed')">Completed</button>
                <button class="action-button delete-btn" onclick="deleteInquiry('${inquiry.id}')">Delete</button>
            </td>
        </tr>
    `).join('');
}

function viewInquiry(id) {
    const inquiry = inquiries.find(i => i.id === id);
    if (!inquiry) return;

    const content = document.getElementById('inquiry-detail-content');
    content.innerHTML = `
        <div class="inquiry-detail">
            <div class="detail-row">
                <strong>Name:</strong>
                <span>${escapeHtml(inquiry.name)}</span>
            </div>
            <div class="detail-row">
                <strong>Email:</strong>
                <span>${escapeHtml(inquiry.email)}</span>
            </div>
            <div class="detail-row">
                <strong>Phone:</strong>
                <span>${escapeHtml(inquiry.phone) || '-'}</span>
            </div>
            <div class="detail-row">
                <strong>Subject:</strong>
                <span>${escapeHtml(inquiry.subject) || '-'}</span>
            </div>
            <div class="detail-row">
                <strong>Service:</strong>
                <span>${escapeHtml(inquiry.service) || '-'}</span>
            </div>
            <div class="detail-row">
                <strong>Budget:</strong>
                <span>${escapeHtml(inquiry.budget) || '-'}</span>
            </div>
            <div class="detail-row">
                <strong>Status:</strong>
                <select id="inquiry-status-select" onchange="updateInquiryStatus('${inquiry.id}', this.value)">
                    <option value="New" ${inquiry.status === 'New' ? 'selected' : ''}>New</option>
                    <option value="Read" ${inquiry.status === 'Read' ? 'selected' : ''}>Read</option>
                    <option value="Replied" ${inquiry.status === 'Replied' ? 'selected' : ''}>Replied</option>
                    <option value="Closed" ${inquiry.status === 'Closed' ? 'selected' : ''}>Closed</option>
                </select>
            </div>
            <div class="detail-row">
                <strong>Message:</strong>
                <p class="message-text">${escapeHtml(inquiry.message)}</p>
            </div>
            <div class="detail-row">
                <strong>Created:</strong>
                <span>${new Date(inquiry.createdAt).toLocaleString()}</span>
            </div>
        </div>
    `;

    document.getElementById('inquiry-modal').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeInquiryModal() {
    document.getElementById('inquiry-modal').classList.remove('active');
    document.body.style.overflow = 'auto';
}

async function updateInquiryStatus(id, status) {
    try {
        const response = await fetch(`/api/admin/inquiries/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        });

        const data = await response.json();

        if (data.success) {
            loadAdminData();
        } else {
            alert('Error updating status. Please try again.');
        }
    } catch (error) {
        console.error('Error updating status:', error);
        alert('Error updating status. Please try again.');
    }
}

async function deleteInquiry(id) {
    if (!confirm('Are you sure you want to delete this contact request?')) return;

    try {
        const response = await fetch(`/api/admin/inquiries/${id}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (data.success) {
            loadAdminData();
        } else {
            alert('Error deleting contact request. Please try again.');
        }
    } catch (error) {
        console.error('Error deleting contact request:', error);
        alert('Error deleting contact request. Please try again.');
    }
}

function setupInquiriesFilters() {
    const searchInput = document.getElementById('inquiries-search');
    const statusFilter = document.getElementById('inquiries-status-filter');

    if (searchInput) searchInput.addEventListener('input', renderInquiriesTable);
    if (statusFilter) statusFilter.addEventListener('change', renderInquiriesTable);
}

// =========================================================
// NOTIFICATIONS MODULE
// =========================================================

function renderNotificationsTable() {
    const tbody = document.getElementById('notifications-table-body');
    if (!tbody) return;

    const typeFilter = document.getElementById('notifications-type-filter')?.value || '';
    const readFilter = document.getElementById('notifications-read-filter')?.value || '';

    let filteredNotifications = notifications.filter(notif => {
        const matchesType = !typeFilter || notif.type === typeFilter;
        const matchesRead = !readFilter || 
            (readFilter === 'unread' && !notif.read) ||
            (readFilter === 'read' && notif.read);

        return matchesType && matchesRead;
    });

    if (filteredNotifications.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No notifications found.</td></tr>';
        return;
    }

    tbody.innerHTML = filteredNotifications.map(notif => `
        <tr class="${notif.read ? '' : 'unread-row'}">
            <td>${escapeHtml(notif.title)}</td>
            <td>${escapeHtml(notif.message)}</td>
            <td><span class="type-badge type-${escapeToken(notif.type)}">${escapeHtml(notif.type)}</span></td>
            <td><span class="status-badge status-${notif.read ? 'read' : 'unread'}">${notif.read ? 'Read' : 'Unread'}</span></td>
            <td>${new Date(notif.createdAt).toLocaleString()}</td>
            <td>
                <button class="action-button" onclick="toggleNotificationRead('${escapeArg(notif.id)}')">${notif.read ? 'Mark Unread' : 'Mark Read'}</button>
                <button class="action-button delete" onclick="deleteNotification('${escapeArg(notif.id)}')">Delete</button>
            </td>
        </tr>
    `).join('');
}

async function toggleNotificationRead(id) {
    const notif = notifications.find(n => n.id === id);
    if (!notif) return;

    try {
        const response = await fetch(`/api/admin/notifications/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ read: !notif.read })
        });

        const data = await response.json();

        if (data.success) {
            loadAdminData();
        } else {
            alert('Error updating notification. Please try again.');
        }
    } catch (error) {
        console.error('Error updating notification:', error);
        alert('Error updating notification. Please try again.');
    }
}

async function markAllNotificationsRead() {
    try {
        const response = await fetch('/api/admin/notifications/mark-all-read', {
            method: 'PUT'
        });

        const data = await response.json();

        if (data.success) {
            loadAdminData();
        } else {
            alert('Error marking all notifications as read. Please try again.');
        }
    } catch (error) {
        console.error('Error marking all notifications as read:', error);
        alert('Error marking all notifications as read. Please try again.');
    }
}

async function deleteNotification(id) {
    if (!confirm('Are you sure you want to delete this notification?')) return;

    try {
        const response = await fetch(`/api/admin/notifications/${id}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (data.success) {
            loadAdminData();
        } else {
            alert('Error deleting notification. Please try again.');
        }
    } catch (error) {
        console.error('Error deleting notification:', error);
        alert('Error deleting notification. Please try again.');
    }
}

function setupNotificationsFilters() {
    const typeFilter = document.getElementById('notifications-type-filter');
    const readFilter = document.getElementById('notifications-read-filter');

    if (typeFilter) typeFilter.addEventListener('change', renderNotificationsTable);
    if (readFilter) readFilter.addEventListener('change', renderNotificationsTable);
}

function loadNotifications() {
    fetch('/api/admin/notifications')
        .then(res => res.json())
        .then(data => {
            notifications = data;
            updateNotificationBadge();
            renderNotificationDropdown();
        })
        .catch(error => console.error('Error loading notifications:', error));
}

function updateNotificationBadge() {
    const badge = document.getElementById('notification-badge');
    const unreadCount = notifications.filter(n => !n.read).length;

    if (badge) {
        if (unreadCount > 0) {
            badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
            badge.style.display = 'flex';
        } else {
            badge.style.display = 'none';
        }
    }
}

function renderNotificationDropdown() {
    const list = document.getElementById('notification-list');
    if (!list) return;

    const recentNotifications = notifications.slice(0, 10);

    if (recentNotifications.length === 0) {
        list.innerHTML = '<div class="no-notifications">No notifications</div>';
        return;
    }

    list.innerHTML = recentNotifications.map(notif => `
        <div class="notification-item ${notif.read ? '' : 'unread'}" onclick="handleNotificationClick('${escapeArg(notif.id)}', '${escapeArg(notif.type)}', '${escapeArg(notif.leadId || '')}', '${escapeArg(notif.inquiryId || '')}')">
            <div class="notification-title">${escapeHtml(notif.title)}</div>
            <div class="notification-message">${escapeHtml(notif.message)}</div>
            <div class="notification-time">${new Date(notif.createdAt).toLocaleString()}</div>
        </div>
    `).join('');
}

function toggleNotifications() {
    const dropdown = document.getElementById('notification-dropdown');
    if (dropdown) {
        dropdown.classList.toggle('active');
    }
}

function handleNotificationClick(id, type, leadId, inquiryId) {
    // Mark as read
    toggleNotificationRead(id);

    // Navigate to relevant section
    if (type === 'lead' && leadId) {
        navigateToSection('leads');
    } else if (type === 'contact' && inquiryId) {
        navigateToSection('inquiries');
    }

    // Close dropdown
    const dropdown = document.getElementById('notification-dropdown');
    if (dropdown) {
        dropdown.classList.remove('active');
    }
}

function navigateToNotifications() {
    navigateToSection('notifications');
    const dropdown = document.getElementById('notification-dropdown');
    if (dropdown) {
        dropdown.classList.remove('active');
    }
}

// Close notification dropdown when clicking outside
document.addEventListener('click', function(e) {
    const container = document.querySelector('.notification-container');
    const dropdown = document.getElementById('notification-dropdown');
    
    if (container && dropdown && !container.contains(e.target)) {
        dropdown.classList.remove('active');
    }
});
