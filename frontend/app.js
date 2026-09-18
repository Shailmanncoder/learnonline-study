// Authentication State
let authToken = localStorage.getItem('authToken');
let currentUserData = null;
let currentActiveTool = null;

// DOM Elements
const authModal = document.getElementById('auth-modal');
const appContainer = document.getElementById('app-container');
const authForm = document.getElementById('auth-form');
const authTitle = document.getElementById('auth-title');
const authSubtitle = document.getElementById('auth-subtitle');
const authSubmitBtn = document.getElementById('auth-submit');
const authSwitchBtn = document.getElementById('auth-switch-btn');
const authSwitchText = document.getElementById('auth-switch-text');
const authError = document.getElementById('auth-error');
const logoutBtn = document.getElementById('logout-btn');

window.isLoginMode = true;

let confettiRAF = null;

// Helper to update the submit button text (handles both old textContent and new span)
function setAuthBtnText(text) {
    const span = document.getElementById('auth-btn-text');
    if (span) span.textContent = text;
    else authSubmitBtn.textContent = text;
}

// --- URL Routing & History Sync System ---
function syncUrl(path, replace = false) {
    if (window.location.pathname === path) return;
    // Restoring a route on load must REPLACE, not push — otherwise the first
    // Back press just returns to the same page the user is already on.
    if (replace) {
        window.history.replaceState({ path }, '', path);
    } else {
        window.history.pushState({ path }, '', path);
    }
}

function getRouteFromPath(pathname) {
    const clean = (pathname || window.location.pathname).replace(/^\/+|\/+$/g, '');
    const parts = clean.split('/');
    const first = parts[0] || '';
    const second = parts[1] || '';
    return { clean, parts, first, second };
}

// Persists the signed-in user (id, username, role) alongside the token.
// The portal role guards read this, so every auth path must call it.
function persistStudyUser(res, profile, fallbackRole) {
    const user = Object.assign(
        {},
        (res && res.user) || {},
        profile || {}
    );
    if (!user.role && fallbackRole) user.role = fallbackRole;
    try {
        localStorage.setItem('studyUser', JSON.stringify(user));
    } catch (e) { /* private mode */ }
    return user;
}

// A /tool/<id> deep link parked at boot until plan data arrives.
let pendingToolId = null;

// Any portal view requires a live session. Routing is reachable from a logo
// click, the Back button or a pasted URL, so the check has to live here
// rather than only on the login path.
function isAuthenticated() {
    try {
        return !!(authToken || localStorage.getItem('authToken'));
    } catch (e) {
        return !!authToken;
    }
}

function showLandingOnly(replaceHistory = true) {
    document.getElementById('app-container')?.style.setProperty('display', 'none');
    document.getElementById('developer-portal-container')?.style.setProperty('display', 'none');
    document.getElementById('teacher-portal-container')?.style.setProperty('display', 'none');
    const landing = document.getElementById('landing-page');
    if (landing) landing.style.display = 'block';
    document.body.classList.remove('pr-app-open');
    if (replaceHistory && window.location.pathname !== '/') {
        window.history.replaceState({ path: '/' }, '', '/');
    }
}

function handleAppRouting(initial = false) {
    if (!isAuthenticated()) {
        // Signed out: never reveal a portal, whatever the URL says.
        showLandingOnly();
        return;
    }

    const route = getRouteFromPath();
    const savedPortal = localStorage.getItem('activePortalMode');

    // 1. Teacher Hub Routes
    if (route.first === 'teacher' || route.first === 'teacher-hub' || (!route.first && savedPortal === 'teacher')) {
        const user = JSON.parse(localStorage.getItem('studyUser') || '{}');
        if (user && user.role === 'student') {
            // Role-locked. Return them to their own hub rather than dangling
            // a sign-in they'd have to log out of this account to use, and
            // correct the URL so a refresh doesn't retry the same route.
            switchPortal('student', false);
            navigateToSection('dashboard', false);
            syncUrl('/dashboard', true);
            showToast('Teacher Hub requires a teacher account.', 'info');
            return;
        }
        const teacherTab = route.second || localStorage.getItem('activeTeacherTab') || 'dashboard';
        switchPortal('teacher', false);
        switchTeacherTab(teacherTab, false);
        syncUrl(route.second ? `/teacher/${route.second}` : '/teacher', initial);
        return;
    }

    // 2. Developer Hub Routes
    if (route.first === 'developer' || route.first === 'devhub' || (!route.first && savedPortal === 'developer')) {
        const devTab = route.second || localStorage.getItem('activeDevTab') || 'dashboard';
        switchPortal('developer', false);
        if (typeof switchDevTab === 'function') switchDevTab(devTab, false);
        syncUrl(devTab === 'dashboard' ? '/developer' : `/developer/${devTab}`, initial);
        return;
    }

    // 3. Deep link to a single AI tool: /tool/<id>
    if (route.first === 'tool' && route.second) {
        switchPortal('student', false);
        // The tool's own gate needs plan data, which is still in flight at
        // boot; initApp opens it after the profile loads.
        pendingToolId = route.second;
        syncUrl(`/tool/${route.second}`, initial);
        return;
    }

    // 4. Student Hub Section Routes. Every section id belongs here — one
    // missing entry silently sends a refresh back to the dashboard.
    const validSections = {
        'dashboard': 'dashboard',
        'focustimer': 'focus',
        'focus': 'focus',
        'ai-chat': 'ai-chat',
        'companion': 'ai-chat',
        'classroom': 'classroom',
        'classes': 'classroom',
        'worksheets': 'worksheets',
        'notes': 'notes',
        'tools': 'tools',
        'creative': 'creative',
        'summarizers': 'summarizers',
        'leaderboard': 'leaderboard',
        'flashcards': 'flashcards',
        'quiz-generator': 'quiz-generator',
        'quiz': 'quiz-generator',
        'study-roadmap': 'study-roadmap',
        'roadmap': 'study-roadmap',
        'profile': 'profile',
        'settings': 'profile'
    };

    let targetSection = validSections[route.first];
    if (!targetSection) {
        targetSection = 'dashboard';
    }

    switchPortal('student', false);
    navigateToSection(targetSection, false);
    syncUrl(targetSection === 'focus' ? '/focustimer' : `/${targetSection}`, initial);
}

window.addEventListener('popstate', () => {
    handleAppRouting(false);
});

// Initialize App
async function initApp() {
    if (authToken) {
        try {
            currentUserData = await api.getProfile(authToken);
            // Backfill the role record for sessions that predate it, so the
            // portal guards work on a restored session too. The profile
            // endpoint is the authority on role; only fall back to the
            // stored record if it somehow comes back without one.
            const knownRole = (() => {
                try { return JSON.parse(localStorage.getItem('studyUser') || '{}').role; }
                catch (e) { return undefined; }
            })();
            persistStudyUser(null, currentUserData, currentUserData?.role || knownRole);
            if (window.hideLanding) window.hideLanding();
            authModal.style.display = 'none';
            handleAppRouting(true);
            updateDashboardUI();
            renderActivity();
            loadTools();
            if (pendingToolId) {
                const tool = toolsData.find(t => t.id === pendingToolId);
                pendingToolId = null;
                if (tool) openTool(tool, false);
            }
            loadNotes();
            loadLeaderboard();
        } catch (err) {
            console.error(err);
            localStorage.removeItem('authToken');
            localStorage.removeItem('token');
            authToken = null;
            showAuth();
        }
    } else {
        showAuth();
    }
}

// Auth UI Logic
function showAuth() {
    authModal.style.display = 'none';
    appContainer.style.display = 'none';
    if (window.showLanding) window.showLanding();
    syncUrl('/');
}

function showApp() {
    authModal.style.display = 'none';
    if (window.hideLanding) window.hideLanding();
    handleAppRouting(true);
    showWelcomeSplash();
}

function showAppContainer() {
    appContainer.style.display = 'flex';
    appContainer.style.opacity = '0';
    requestAnimationFrame(() => {
        appContainer.style.transition = 'opacity 0.5s ease';
        appContainer.style.opacity = '1';
    });
}

function logout() {
    const modal = document.getElementById('logout-modal');
    if (modal) modal.style.display = 'flex';
}

// Everything the session owns. `theme` is deliberately kept — it's a device
// preference, not account data.
const SESSION_KEYS = [
    'authToken', 'token', 'studyUser',
    'activePortalMode', 'activeTeacherTab', 'activeDevTab',
    'selectedDevSkill', 'teacherSubject',
    'studyUserNotes', 'currentPlanData', 'unlockedTools'
];

function performFullLogout() {
    try {
        SESSION_KEYS.forEach((k) => localStorage.removeItem(k));
        sessionStorage.clear();
    } catch (e) { /* private mode */ }

    authToken = null;
    currentUserData = null;
    if (typeof grokChatHistory !== 'undefined') grokChatHistory = [];

    // replace(), not reload(): reloading keeps the in-app URL in history, so
    // one Back press walked straight back into the signed-out account view.
    window.location.replace('/');
}

// Attach logout listeners across all portals
document.getElementById('logout-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    logout();
});
document.getElementById('drop-logout')?.addEventListener('click', (e) => {
    e.preventDefault();
    logout();
});
document.getElementById('teacher-logout-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    logout();
});
document.getElementById('devhub-logout-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    logout();
});

document.getElementById('btn-just-logout')?.addEventListener('click', () => {
    performFullLogout();
});

document.getElementById('btn-delete-data')?.addEventListener('click', async () => {
    try {
        if (authToken) await api.deleteAccount(authToken);
    } catch (err) {
        console.error("Failed to delete account on server:", err);
    }
    performFullLogout();
});

document.getElementById('btn-cancel-logout')?.addEventListener('click', () => {
    const modal = document.getElementById('logout-modal');
    if (modal) modal.style.display = 'none';
});

// Close logout modal when clicking outside
document.getElementById('logout-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'logout-modal') {
        document.getElementById('logout-modal').style.display = 'none';
    }
});

// ================================================================
// 1. STUDENT AUTHENTICATION FLOW
// ================================================================
window.isLoginMode = true;

authSwitchBtn.addEventListener('click', (e) => {
    e.preventDefault();
    window.isLoginMode = !window.isLoginMode;
    authTitle.textContent = window.isLoginMode ? 'Student Sign In' : 'Create Student Account';
    authSubtitle.textContent = window.isLoginMode ? 'Log in to continue to your AI Study Hub' : 'Join thousands of students on StudyHub';
    authSwitchText.textContent = window.isLoginMode ? "Don't have a student account?" : "Already have an account?";
    authSwitchBtn.textContent = window.isLoginMode ? 'Sign Up' : 'Log In';
    setAuthBtnText(window.isLoginMode ? 'Enter Student Portal' : 'Create Account');
    authError.textContent = '';
});

authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    authError.textContent = '';
    authSubmitBtn.disabled = true;
    setAuthBtnText('Processing...');

    try {
        let res;
        if (window.isLoginMode) {
            res = await api.login(username, password);
        } else {
            res = await api.register(username, password);
        }
        authToken = res.token;
        localStorage.setItem('authToken', authToken);
        localStorage.setItem('activePortalMode', 'student');
        currentUserData = await api.getProfile(authToken);
        persistStudyUser(res, currentUserData, 'student');

        showApp();
    } catch (err) {
        authError.textContent = err.message;
    } finally {
        authSubmitBtn.disabled = false;
        setAuthBtnText(window.isLoginMode ? 'Enter Student Portal' : 'Create Account');
    }
});

// ================================================================
// 2. DEVELOPER AUTHENTICATION FLOW (COMPLETELY SEPARATE)
// ================================================================
const devAuthModal = document.getElementById('dev-auth-modal');
const devAuthForm = document.getElementById('dev-auth-form');
const devAuthTitle = document.getElementById('dev-auth-title');
const devAuthSubtitle = document.getElementById('dev-auth-subtitle');
const devAuthSubmitBtn = document.getElementById('dev-auth-submit');
const devAuthSwitchBtn = document.getElementById('dev-auth-switch-btn');
const devAuthSwitchText = document.getElementById('dev-auth-switch-text');
const devAuthError = document.getElementById('dev-auth-error');
const devAuthCloseBtn = document.getElementById('dev-auth-close-btn');
const devAuthSkillSelect = document.getElementById('dev-auth-skill-select');
const devTogglePw = document.getElementById('dev-toggle-pw');

window.isDevLoginMode = true;

function setDevAuthBtnText(text) {
    const span = document.getElementById('dev-auth-btn-text');
    if (span) span.textContent = text;
    else if (devAuthSubmitBtn) devAuthSubmitBtn.textContent = text;
}

if (devAuthCloseBtn) {
    devAuthCloseBtn.addEventListener('click', () => {
        if (devAuthModal) devAuthModal.style.display = 'none';
    });
}

if (devTogglePw) {
    devTogglePw.addEventListener('click', () => {
        const pwInput = document.getElementById('dev-password');
        if (pwInput) {
            const isText = pwInput.type === 'text';
            pwInput.type = isText ? 'password' : 'text';
            devTogglePw.innerHTML = isText ? '<i class="fa-solid fa-eye"></i>' : '<i class="fa-solid fa-eye-slash"></i>';
        }
    });
}

if (devAuthSwitchBtn) {
    devAuthSwitchBtn.addEventListener('click', (e) => {
        e.preventDefault();
        window.isDevLoginMode = !window.isDevLoginMode;
        if (devAuthTitle) devAuthTitle.textContent = window.isDevLoginMode ? 'Developer Sign In' : 'Register Developer';
        if (devAuthSubtitle) devAuthSubtitle.textContent = window.isDevLoginMode ? 'Enter Developer Hub for mock tests, AI code review & skills' : 'Create your developer profile to practice & level up';
        if (devAuthSwitchText) devAuthSwitchText.textContent = window.isDevLoginMode ? "Don't have a developer account?" : "Already registered as developer?";
        if (devAuthSwitchBtn) devAuthSwitchBtn.textContent = window.isDevLoginMode ? 'Sign Up' : 'Log In';
        setDevAuthBtnText(window.isDevLoginMode ? 'Enter Developer Portal' : 'Register as Developer');
        if (devAuthError) devAuthError.textContent = '';
    });
}

// Landing Page Developer Login Openers
document.getElementById('nav-dev-login-btn')?.addEventListener('click', () => {
    if (devAuthModal) devAuthModal.style.display = 'flex';
    if (authModal) authModal.style.display = 'none';
});
document.getElementById('mobile-dev-login-btn')?.addEventListener('click', () => {
    if (devAuthModal) devAuthModal.style.display = 'flex';
    if (authModal) authModal.style.display = 'none';
});
document.getElementById('hero-dev-btn')?.addEventListener('click', () => {
    if (devAuthModal) devAuthModal.style.display = 'flex';
    if (authModal) authModal.style.display = 'none';
});

if (devAuthForm) {
    devAuthForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('dev-username').value;
        const password = document.getElementById('dev-password').value;
        const devSkill = devAuthSkillSelect?.value || 'Python & AI / Data Science';
        if (devAuthError) devAuthError.textContent = '';
        if (devAuthSubmitBtn) devAuthSubmitBtn.disabled = true;
        setDevAuthBtnText('Authenticating...');

        try {
            let res;
            if (window.isDevLoginMode) {
                res = await api.login(username, password);
            } else {
                res = await api.register(username, password);
            }
            authToken = res.token;
            localStorage.setItem('authToken', authToken);
            localStorage.setItem('activePortalMode', 'developer');
            localStorage.setItem('selectedDevSkill', devSkill);
            currentUserData = await api.getProfile(authToken);
            persistStudyUser(res, currentUserData, 'developer');

            if (devAuthModal) devAuthModal.style.display = 'none';
            showDeveloperPortal('dashboard');
        } catch (err) {
            if (devAuthError) devAuthError.textContent = err.message;
        } finally {
            if (devAuthSubmitBtn) devAuthSubmitBtn.disabled = false;
            setDevAuthBtnText(window.isDevLoginMode ? 'Enter Developer Portal' : 'Register as Developer');
        }
    });
}

// ================================================================
// 3. TEACHER AUTHENTICATION FLOW
// ================================================================
window.isTeacherLoginMode = true;
const teacherAuthModal = document.getElementById('teacher-auth-modal');
const teacherAuthForm = document.getElementById('teacher-auth-form');
const teacherAuthTitle = document.getElementById('teacher-auth-title');
const teacherAuthSubtitle = document.getElementById('teacher-auth-subtitle');
const teacherAuthSubmitBtn = document.getElementById('teacher-auth-submit');
const teacherAuthSwitchBtn = document.getElementById('teacher-auth-switch-btn');
const teacherAuthSwitchText = document.getElementById('teacher-auth-switch-text');
const teacherAuthError = document.getElementById('teacher-auth-error');
const teacherAuthCloseBtn = document.getElementById('teacher-auth-close-btn');
const teacherTogglePw = document.getElementById('teacher-toggle-pw');
const teacherModalSubjectGroup = document.getElementById('teacher-modal-subject-group');
const teacherAuthSubjectSelect = document.getElementById('teacher-auth-subject-select');

function setTeacherAuthBtnText(text) {
    const span = document.getElementById('teacher-auth-btn-text');
    if (span) span.textContent = text;
    else if (teacherAuthSubmitBtn) teacherAuthSubmitBtn.textContent = text;
}

if (teacherAuthCloseBtn) {
    teacherAuthCloseBtn.addEventListener('click', () => {
        if (teacherAuthModal) teacherAuthModal.style.display = 'none';
    });
}

if (teacherTogglePw) {
    teacherTogglePw.addEventListener('click', () => {
        const pwInput = document.getElementById('teacher-password');
        if (pwInput) {
            const isText = pwInput.type === 'text';
            pwInput.type = isText ? 'password' : 'text';
            teacherTogglePw.innerHTML = isText ? '<i class="fa-solid fa-eye"></i>' : '<i class="fa-solid fa-eye-slash"></i>';
        }
    });
}

if (teacherAuthSwitchBtn) {
    teacherAuthSwitchBtn.addEventListener('click', (e) => {
        e.preventDefault();
        window.isTeacherLoginMode = !window.isTeacherLoginMode;
        if (teacherAuthTitle) teacherAuthTitle.textContent = window.isTeacherLoginMode ? 'Teacher Sign In' : 'Register as Teacher';
        if (teacherAuthSubtitle) teacherAuthSubtitle.textContent = window.isTeacherLoginMode ? 'Access your Google Classroom-style Teacher Hub & Worksheets' : 'Create your educator profile to manage classes & assignments';
        if (teacherAuthSwitchText) teacherAuthSwitchText.textContent = window.isTeacherLoginMode ? "Don't have a teacher account?" : "Already registered as teacher?";
        if (teacherAuthSwitchBtn) teacherAuthSwitchBtn.textContent = window.isTeacherLoginMode ? 'Sign Up as Teacher' : 'Log In';
        if (teacherModalSubjectGroup) teacherModalSubjectGroup.style.display = window.isTeacherLoginMode ? 'none' : 'block';
        setTeacherAuthBtnText(window.isTeacherLoginMode ? 'Enter Teacher Portal' : 'Register as Teacher');
        if (teacherAuthError) teacherAuthError.textContent = '';
    });
}

// Landing Page Teacher Login Openers
document.getElementById('nav-teacher-login-btn')?.addEventListener('click', () => {
    if (teacherAuthModal) teacherAuthModal.style.display = 'flex';
    if (authModal) authModal.style.display = 'none';
    if (devAuthModal) devAuthModal.style.display = 'none';
});
document.getElementById('mobile-teacher-login-btn')?.addEventListener('click', () => {
    if (teacherAuthModal) teacherAuthModal.style.display = 'flex';
    if (authModal) authModal.style.display = 'none';
    if (devAuthModal) devAuthModal.style.display = 'none';
});

if (teacherAuthForm) {
    teacherAuthForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('teacher-username').value;
        const password = document.getElementById('teacher-password').value;
        const subject = teacherAuthSubjectSelect?.value || 'Mathematics';
        if (teacherAuthError) teacherAuthError.innerHTML = '';
        if (teacherAuthSubmitBtn) teacherAuthSubmitBtn.disabled = true;
        setTeacherAuthBtnText('Authenticating...');

        try {
            let res;
            if (window.isTeacherLoginMode) {
                // Pass requiredRole = 'teacher' to enforce server-side role check
                res = await api.login(username, password, 'teacher');
            } else {
                // Register as teacher
                res = await api.register(username, password, 'teacher');
            }
            authToken = res.token;
            localStorage.setItem('authToken', authToken);
            localStorage.setItem('activePortalMode', 'teacher');
            localStorage.setItem('teacherSubject', subject);
            currentUserData = await api.getProfile(authToken);
            persistStudyUser(res, currentUserData, 'teacher');

            if (teacherAuthModal) teacherAuthModal.style.display = 'none';
            showToast(`Welcome Teacher ${getCleanStudentName()}! 👨‍🏫`, 'success');
            switchPortal('teacher');
        } catch (err) {
            console.error('[TEACHER AUTH ERROR]', err);
            if (teacherAuthError) {
                if (err.notFound || err.requiresRegister) {
                    teacherAuthError.innerHTML = `
                        <div style="background: rgba(239,68,68,0.1); border: 1px solid #EF4444; border-radius: 10px; padding: 10px; margin-top: 6px; color: #DC2626; font-size: 13px; text-align: center;">
                            <strong>Teacher account not found!</strong><br>
                            Please create your educator account first.<br>
                            <button type="button" id="btn-quick-switch-teacher-reg" style="margin-top: 8px; background: #059669; color: #fff; border: none; border-radius: 8px; padding: 6px 14px; font-weight: 700; font-size: 12px; cursor: pointer;">
                                <i class="fa-solid fa-user-plus"></i> Create Teacher Account Now
                            </button>
                        </div>
                    `;
                    document.getElementById('btn-quick-switch-teacher-reg')?.addEventListener('click', () => {
                        teacherAuthSwitchBtn?.click();
                    });
                } else if (err.isStudent) {
                    teacherAuthError.innerHTML = `
                        <div style="background: rgba(239,68,68,0.1); border: 1px solid #EF4444; border-radius: 10px; padding: 10px; margin-top: 6px; color: #DC2626; font-size: 13px; text-align: center;">
                            <strong>Student Account Detected!</strong><br>
                            Students cannot access the Teacher Portal.<br>
                            Please sign up with a new Teacher account.
                        </div>
                    `;
                } else {
                    teacherAuthError.textContent = err.message || 'Authentication failed. Please check credentials.';
                }
            }
        } finally {
            if (teacherAuthSubmitBtn) teacherAuthSubmitBtn.disabled = false;
            setTeacherAuthBtnText(window.isTeacherLoginMode ? 'Enter Teacher Portal' : 'Register as Teacher');
        }
    });
}

// --- Global Audio Voice Manager (Zero collisions, single stream) ---
const globalVoicePlayer = {
    audio: null,
    currentBtn: null,
    defaultHtml: '',
    isPlaying() {
        return this.audio && !this.audio.paused;
    },
    stop() {
        if (this.audio) {
            try {
                this.audio.pause();
                this.audio.currentTime = 0;
            } catch {}
            this.audio = null;
        }
        if (this.currentBtn && this.defaultHtml) {
            this.currentBtn.innerHTML = this.defaultHtml;
        }
        this.currentBtn = null;
        this.defaultHtml = '';
    },
    play(base64Audio, btn, defaultHtml) {
        this.stop();
        this.currentBtn = btn;
        this.defaultHtml = defaultHtml;
        this.audio = new Audio('data:audio/wav;base64,' + base64Audio);
        this.audio.play().catch(e => console.warn('Audio play error:', e));
        this.audio.onended = () => {
            this.stop();
        };
        this.audio.onerror = () => {
            this.stop();
        };
    }
};

// --- App UI Logic ---
function getAvatarUrl(seed) {
    return `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(seed)}`;
}

function getDefaultAvatarForUser(user) {
    const seed = (user && user.username) ? user.username : 'default';
    return getAvatarUrl(seed);
}

function isBlank(v) {
    return v == null || String(v).trim().length === 0;
}

function resolveAvatarUrl(profilePicture, user) {
    // Keep ONLY user-uploaded images (data URLs). Everything else falls back to robot.
    // This prevents random/legacy photo URLs from showing as the default avatar.
    if (!isBlank(profilePicture)) {
        const s = String(profilePicture).trim();
        if (s.startsWith('data:image/')) return s;
    }
    return getDefaultAvatarForUser(user);
}

let activeTypewriter = { cancel: () => {} };

async function typewriterInto(el, text, { cps = 140, maxMs = 4500 } = {}) {
    if (!el) return;
    const s = String(text ?? '');

    // Cancel any in-flight animation for this output area
    try { activeTypewriter.cancel(); } catch {}

    let cancelled = false;
    activeTypewriter = { cancel: () => { cancelled = true; } };

    el.textContent = '';

    // Fast path for short text
    if (s.length <= 60) {
        el.textContent = s;
        return;
    }

    const chunk = Math.max(8, Math.floor(cps / 10));
    const startedAt = Date.now();
    for (let i = 0; i < s.length; i += chunk) {
        if (cancelled) return;
        // If the response is long, don't keep "typing" forever—finish quickly.
        if (Date.now() - startedAt > maxMs) {
            el.textContent += s.slice(i);
            break;
        }
        el.textContent += s.slice(i, i + chunk);
        // yield to browser
        await new Promise(r => setTimeout(r, 25));
    }
}

// Every tool's AI output goes through the same math-safe renderer as the
// Companion. This used to call marked.parse directly: marked treats "\[" as
// an escaped "[" and emits a bare "[", and KaTeX was only told about $...$,
// so a Math Solver answer arrived as "[ 568^2 = 568 \times 568 ]" with the
// formula never rendered. One renderer, so the tools and the chat cannot
// drift apart again.
function renderOutputWithMath(el, text) {
    if (!el) return;
    el.innerHTML = renderAiMarkdown(text);
    renderChatMath(el);
}

async function renderWithTyping(el, text, { renderMath = false } = {}) {
    await typewriterInto(el, text);
    // After typing, render markdown and optional math for crisp display.
    if (renderMath) {
        renderOutputWithMath(el, text);
    } else {
        // Still math-safe: a tool that did not ask for math can receive it
        // anyway, and plain marked.parse would strip its backslashes.
        el.innerHTML = renderAiMarkdown(text);
    }
}

function enableAutoGrow(textarea) {
    if (!textarea) return;
    const grow = () => {
        textarea.style.height = 'auto';
        const max = 360; // keep page usable; output remains visible
        textarea.style.height = `${Math.min(max, textarea.scrollHeight)}px`;
    };
    textarea.addEventListener('input', grow);
    textarea.addEventListener('paste', () => setTimeout(grow, 0));
    grow();
}

function getMathSolverTextarea() {
    return document.getElementById('input-problem') || document.getElementById('tool-input');
}

// Apply XP result from api.addXp() and refresh UI — single source of truth
function applyXpResult(res) {
    if (!res) return;
    if (!currentUserData) currentUserData = {};
    currentUserData.xp = res.xp ?? currentUserData.xp;
    currentUserData.level = res.newLevel ?? res.level ?? currentUserData.level;
    if (res.time_spent !== undefined) currentUserData.time_spent = res.time_spent;
    if (res.studied_today !== undefined) currentUserData.studied_today = res.studied_today;
    if (res.streak !== undefined) currentUserData.streak = res.streak;
    updateDashboardUI();

    // Check for newly-earned badges in the background — celebrate without blocking the UI
    if (authToken) {
        api.checkNewBadges(authToken).then(r => {
            (r.newlyAwarded || []).forEach(badge => {
                showToast(`🏅 Badge unlocked: ${badge.label}! ${badge.description}`, 'success');
            });
        }).catch(() => {});
    }
}

// Lazily creates a fullscreen image-view modal used by image/diagram tools.
// Defined as top-level function so it's hoisted and available to all call sites.
function getOrCreateImageViewModal() {
    let modal = document.getElementById('image-view-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'image-view-modal';
    modal.style.position = 'fixed';
    modal.style.inset = '0';
    modal.style.zIndex = '9999';
    modal.style.display = 'none';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
    modal.style.background = 'rgba(0,0,0,0.65)';
    modal.style.backdropFilter = 'blur(6px)';
    modal.innerHTML = `
        <div id="image-view-modal-card" style="position: relative; width: min(1100px, 92vw); max-height: 88vh; padding: 14px; border-radius: 14px; background: rgba(255,255,255,0.9); border: 1px solid rgba(255,255,255,0.25); overflow: auto;">
            <button id="image-view-close" class="icon-btn" style="position:absolute; top:10px; right:10px; font-size:18px; background: rgba(0,0,0,0.06); border-radius: 10px; padding: 8px 10px;">
                <i class="fa-solid fa-xmark"></i>
            </button>
            <div style="padding-top: 30px; display:flex; justify-content:center;">
                <img id="image-view-modal-img" alt="Generated image" style="max-width: 100%; height: auto; object-fit: contain; border-radius: 10px; image-rendering: auto;">
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    const close = () => { modal.style.display = 'none'; };
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('#image-view-close')?.addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    return modal;
}

// Motivational quotes that rotate on each greeting
const HERO_QUOTES = [
    "Small steps every day lead to big results.",
    "Your future self will thank you for the work you do today.",
    "Knowledge compounds — every minute studied counts.",
    "Done is better than perfect. Just start.",
    "The expert in anything was once a beginner.",
    "Focus on progress, not perfection.",
    "One AI tool at a time, you're getting smarter.",
    "Success is the sum of small efforts repeated daily."
];

// Animate a number from current to target value
function animateCount(el, target, duration = 900, suffix = '') {
    if (!el) return;
    const start = parseFloat((el.textContent || '0').replace(/[^0-9.-]/g, '')) || 0;
    const diff = target - start;
    if (diff === 0) { el.textContent = target.toLocaleString() + suffix; return; }
    const startTime = performance.now();
    const step = (now) => {
        const t = Math.min(1, (now - startTime) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        const value = Math.round(start + diff * eased);
        el.textContent = value.toLocaleString() + suffix;
        if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

// Set time-based greeting and rotating quote
function setHeroGreeting() {
    const hour = new Date().getHours();
    let greeting = 'Welcome back';
    if (hour < 5) greeting = 'Burning the midnight oil';
    else if (hour < 12) greeting = 'Good morning';
    else if (hour < 17) greeting = 'Good afternoon';
    else if (hour < 21) greeting = 'Good evening';
    else greeting = 'Good night';
    const greetingEl = document.getElementById('hero-time-greeting');
    if (greetingEl) greetingEl.textContent = greeting;

    const quoteEl = document.getElementById('hero-quote');
    if (quoteEl) {
        const idx = Math.floor(Math.random() * HERO_QUOTES.length);
        quoteEl.textContent = HERO_QUOTES[idx];
    }
}

// Extract clean first name from email or username (e.g. asha.verma@example.com -> Asha)
function getCleanStudentName(raw) {
    const rawUser = raw || (currentUserData && (currentUserData.username || currentUserData.email)) || localStorage.getItem('username') || 'Shailmann';
    let str = rawUser.includes('@') ? rawUser.split('@')[0] : rawUser;
    // Strip trailing suffixes like coder, dev, student, official, numbers
    str = str.replace(/(coder|dev|student|official|user|[0-9_.-]+)+$/gi, '');
    if (str.length < 2) {
        str = rawUser.split('@')[0].replace(/[0-9_.-]+/g, '') || 'Shailmann';
    }
    // Clean duplicate mm to single m (e.g. shailmmann -> Shailmann)
    str = str.replace(/mm/gi, 'm');
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function updateDashboardUI() {
    setHeroGreeting();

    let rawUser = (currentUserData && currentUserData.username) || (currentUserData && currentUserData.email) || localStorage.getItem('username') || 'Shailmann';
    let displayName = getCleanStudentName(rawUser);
    let userEmail = (currentUserData && currentUserData.email) || (rawUser.includes('@') ? rawUser : `${rawUser.toLowerCase()}@gmail.com`);

    const heroName = document.getElementById('hero-username');
    if (heroName) heroName.textContent = displayName;

    const grokWelcomeName = document.getElementById('grok-user-welcome-name');
    if (grokWelcomeName) grokWelcomeName.textContent = displayName;

    const xp = (currentUserData && currentUserData.xp !== undefined) ? currentUserData.xp : 160;
    const level = (currentUserData && currentUserData.level !== undefined) ? currentUserData.level : 2;
    // Studied Today: Resets every 24 hours / daily
    const time = (currentUserData && currentUserData.studied_today !== undefined) 
        ? currentUserData.studied_today 
        : (currentUserData && currentUserData.time_spent !== undefined ? currentUserData.time_spent : 0);
    const streak = (currentUserData && currentUserData.streak !== undefined) ? currentUserData.streak : 1;

    const xpEl = document.getElementById('dash-xp');
    if (xpEl) animateCount(xpEl, xp);
    const timeEl = document.getElementById('dash-time');
    if (timeEl) animateCount(timeEl, time, 900, ' min');
    const streakEl = document.getElementById('dash-streak');
    if (streakEl) animateCount(streakEl, streak);
    refreshStreakFreezeUI();
    loadWeaknessRadar();
    const levelEl = document.getElementById('dash-level');
    if (levelEl) animateCount(levelEl, level);

    const miniUser = document.getElementById('mini-username');
    if (miniUser) miniUser.textContent = userEmail;
    const miniLevel = document.getElementById('mini-level');
    if (miniLevel) miniLevel.textContent = level;

    const miniAvatar = document.getElementById('mini-avatar-letter');
    if (miniAvatar) {
        miniAvatar.textContent = (displayName[0] || 'S').toUpperCase();
    }

    const avatarUrl = resolveAvatarUrl(currentUserData?.profile_picture, currentUserData);
    const miniImg = document.getElementById('mini-avatar');
    if (miniImg) miniImg.src = avatarUrl;

    // Also update settings prepopulation
    const sPreview = document.getElementById('settings-avatar-preview');
    if (sPreview) sPreview.src = avatarUrl;
    const sUrl = document.getElementById('settings-avatar-url');
    if (sUrl) sUrl.value = currentUserData?.profile_picture || '';
    const sUser = document.getElementById('settings-username');
    if (sUser) sUser.value = currentUserData?.username || '';
    const sBio = document.getElementById('settings-bio');
    if (sBio) sBio.value = currentUserData?.bio || '';

    // XP Progress Bar
    const xpPerLevel = 100;
    const xpIntoLevel = xp % xpPerLevel === 0 && xp > 0 ? 60 : (xp % xpPerLevel);
    const pct = Math.min(100, (xpIntoLevel / xpPerLevel) * 100);
    const fillEl = document.getElementById('xp-fill');
    const labelEl = document.getElementById('xp-level-label');
    const textEl = document.getElementById('xp-prog-text');
    if (fillEl) setTimeout(() => { fillEl.style.width = pct + '%'; }, 100);
    if (labelEl) labelEl.textContent = level;
    if (textEl) textEl.textContent = `${xpIntoLevel} / ${xpPerLevel} XP`;
}

// 24-Hour Midnight Rollover Watcher (Resets "Studied Today" to 0 each new day)
let lastTrackedDay = new Date().toISOString().split('T')[0];
setInterval(() => {
    const currentDay = new Date().toISOString().split('T')[0];
    if (currentDay !== lastTrackedDay) {
        lastTrackedDay = currentDay;
        if (currentUserData) {
            currentUserData.studied_today = 0;
            updateDashboardUI();
        }
        if (authToken) {
            api.getProfile(authToken).then(profile => {
                if (profile) {
                    currentUserData = { ...currentUserData, ...profile };
                    updateDashboardUI();
                }
            }).catch(() => {});
        }
    }
}, 15000); // Checks every 15 seconds for instantaneous 24h midnight rollover

// ---- Recent activity feed ----
function loadActivity() {
    try {
        const raw = localStorage.getItem('recent_activity');
        return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
}
function saveActivity(list) {
    try { localStorage.setItem('recent_activity', JSON.stringify(list.slice(0, 8))); } catch (e) {}
}
function recordActivity(toolName, icon, xpGained) {
    const list = loadActivity();
    list.unshift({
        name: toolName,
        icon: icon || 'fa-solid fa-wand-magic-sparkles',
        xp: xpGained || 0,
        time: Date.now()
    });
    saveActivity(list);
    renderActivity();
}
function timeAgo(ts) {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return 'just now';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
    return Math.floor(sec / 86400) + 'd ago';
}
function renderActivity() {
    const ul = document.getElementById('activity-list');
    if (!ul) return;
    const list = loadActivity();
    if (!list.length) {
        ul.innerHTML = `
            <li class="activity-empty">
                <i class="fa-solid fa-seedling"></i>
                <p>Your activity will appear here</p>
                <span>Try a tool to get started</span>
            </li>`;
        return;
    }
    ul.innerHTML = list.map(item => `
        <li class="activity-item">
            <div class="activity-item-icon"><i class="${item.icon}"></i></div>
            <div class="activity-item-text">
                <h5>${item.name}</h5>
                <span>${timeAgo(item.time)}</span>
            </div>
            ${item.xp ? `<div class="activity-item-xp">+${item.xp} XP</div>` : ''}
        </li>
    `).join('');
}

// Wire up quick-launch and hero CTAs (delegated since they're inside the dashboard)
document.addEventListener('click', (e) => {
    const targetEl = e.target.closest('[data-jump-target]');
    if (targetEl) {
        const target = targetEl.getAttribute('data-jump-target');
        const navItem = document.querySelector(`.nav-item[data-target="${target}"]`);
        if (navItem) navItem.click();
        return;
    }
    const toolEl = e.target.closest('[data-jump-tool]');
    if (toolEl) {
        const toolId = toolEl.getAttribute('data-jump-tool');
        const tool = (typeof toolsData !== 'undefined') && toolsData.find(t => t.id === toolId);
        if (tool) openTool(tool);
    }
});

// Navigation
const navItems = document.querySelectorAll('.nav-item[data-target]');
const sections = document.querySelectorAll('.section-container');

function navigateToSection(target, updateUrl = true) {
    navItems.forEach(n => n.classList.remove('active'));
    const activeItem = document.querySelector(`.nav-item[data-target="${target}"]`);
    if (activeItem) activeItem.classList.add('active');

    sections.forEach(s => s.classList.remove('active'));
    const targetSection = document.getElementById(target);
    if (targetSection) targetSection.classList.add('active');

    if (target === 'leaderboard') loadLeaderboard();
    if (target === 'tools') loadTools();
    if (target === 'notes') loadNotes();
    if (target === 'classroom') loadStudentClassrooms();
    if (target === 'flashcards') loadFlashcardDecks();
    if (target === 'quiz-generator') resetQuizUI();
    if (target === 'profile') loadBadges();
    if (target === 'dashboard') loadWeaknessRadar();

    if (updateUrl) {
        const path = target === 'focus' ? '/focustimer' : `/${target}`;
        syncUrl(path);
    }
}

navItems.forEach(item => {
    item.addEventListener('click', () => {
        const target = item.getAttribute('data-target');
        navigateToSection(target, true);
    });
});

const hamburgerBtn = document.getElementById('hamburger-btn');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const sidebar = document.querySelector('.sidebar');

if (hamburgerBtn && sidebarOverlay && sidebar) {
    hamburgerBtn.addEventListener('click', () => {
        sidebar.classList.add('open');
        sidebarOverlay.classList.add('active');
    });

    sidebarOverlay.addEventListener('click', () => {
        sidebar.classList.remove('open');
        sidebarOverlay.classList.remove('active');
    });

    // Close sidebar on mobile when a nav item is clicked
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            sidebar.classList.remove('open');
            sidebarOverlay.classList.remove('active');
        });
    });
}

// Topbar user mini dropdown toggle
(function() {
    const wrap = document.getElementById('profile-btn-wrap');
    const btn  = document.getElementById('profile-btn');
    const drop = document.getElementById('mini-dropdown');

    function openProfileSection() {
        navigateToSection('profile', true);
    }

    function closeDrop() {
        wrap.classList.remove('open');
        drop.classList.remove('open');
    }

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = drop.classList.contains('open');
        if (isOpen) { closeDrop(); } else { wrap.classList.add('open'); drop.classList.add('open'); }
    });

    document.addEventListener('click', (e) => {
        if (!wrap.contains(e.target)) closeDrop();
    });

    document.getElementById('drop-profile').addEventListener('click', () => {
        closeDrop();
        openProfileSection();
    });

    document.getElementById('drop-logout').addEventListener('click', () => {
        closeDrop();
        logout();
    });
})();

document.getElementById('profile-nav-btn').addEventListener('click', () => {
    navigateToSection('profile', true);
});

// Quick Tools sidebar shortcuts
document.querySelectorAll('.quick-tool-item').forEach(item => {
    item.addEventListener('click', () => {
        let toolId = item.getAttribute('data-tool');
        if (toolId === 'grammar-checker') toolId = 'grammar-tutor';
        if (toolId === 'code-debugger') toolId = 'bug-fixer';
        const tool = toolsData.find(t => t.id === toolId);
        if (tool) openTool(tool);
    });
});

document.getElementById('settings-avatar-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
            document.getElementById('settings-avatar-preview').src = event.target.result;
            document.getElementById('settings-avatar-url').value = event.target.result;
        };
        reader.readAsDataURL(file);
    }
});

document.getElementById('save-profile-btn').addEventListener('click', async (e) => {
    const btn = document.getElementById('save-profile-btn');
    const msg = document.getElementById('profile-status-msg');
    const newUsername = document.getElementById('settings-username').value;
    const newAvatar = document.getElementById('settings-avatar-url').value;
    const newBio = document.getElementById('settings-bio').value;
    
    msg.textContent = '';
    btn.disabled = true;
    
    try {
        await api.updateProfile(authToken, newUsername, newAvatar, newBio);
        currentUserData.username = newUsername;
        currentUserData.profile_picture = newAvatar;
        currentUserData.bio = newBio;
        updateDashboardUI();
        loadLeaderboard(); // Update leaderboard with new avatar
        msg.style.color = 'var(--success-color)';
        msg.textContent = 'Profile updated successfully!';
    } catch (err) {
        msg.style.color = 'var(--danger-color)';
        msg.textContent = 'Error: Username might be taken.';
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-save"></i> Save Changes';
        setTimeout(() => msg.textContent = '', 3000);
    }
});

// Tool Presets Library
const TOOL_PRESETS = {
    'essay-writer': [
        'Argumentative Essay on AI in Modern Education',
        'College Admissions Personal Statement',
        'Cause and Effect Analysis of Climate Change',
        'Compare & Contrast Literary Essay'
    ],
    'math-solver': [
        'Solve quadratic equation: 3x^2 + 5x - 2 = 0 with step-by-step reasoning',
        'Find derivative of f(x) = sin(x)*e^(2x)',
        'Calculate definite integral of x^3 from 0 to 4',
        'Explain Pythagorean theorem with real-world application'
    ],
    'todo-ai': [
        'Create a 7-day study plan for final exam week',
        'Break down 10-page research paper project into daily tasks',
        'Daily habit checklist for high-achieving college student'
    ],
    'coding-assistant': [
        'Write Python script to scrape web articles and save to CSV',
        'Debug JavaScript async/await fetch request error',
        'Build responsive React navbar component with Tailwind',
        'Optimize SQL query for high-traffic student database'
    ],
    'ai-tutor': [
        'Explain Quantum Physics concepts in simple terms',
        'How does DNA replication work in molecular biology?',
        'Teach me Macroeconomics Supply and Demand curve shifts'
    ],
    'pdf-summarizer': [
        'Extract 5 key takeaways and study flashcards',
        'Summarize methodology and experimental conclusions',
        'Generate executive 1-paragraph brief'
    ],
    'creative-writer': [
        'Short sci-fi story about an astronaut discovering a Dyson sphere',
        'Poem about the beauty of mathematics and the universe',
        'Script scene between an AI and a philosophy professor'
    ]
};

let activeToolsCategory = 'all';
let toolsSearchQuery = '';

function getFavoritesList() {
    try {
        return JSON.parse(localStorage.getItem('favTools') || '[]');
    } catch {
        return [];
    }
}

function toggleFavoriteTool(toolId) {
    let favs = getFavoritesList();
    if (favs.includes(toolId)) {
        favs = favs.filter(id => id !== toolId);
        showToast('Removed from favorites', 'info');
    } else {
        favs.push(toolId);
        showToast('⭐ Saved to favorites!', 'success');
    }
    localStorage.setItem('favTools', JSON.stringify(favs));
    updateCategoryCounts();
    loadTools();
    updateActiveToolFavBtn();
}

function updateActiveToolFavBtn() {
    const favBtn = document.getElementById('active-tool-fav-btn');
    if (!favBtn || !currentActiveTool) return;
    const favs = getFavoritesList();
    const isFav = favs.includes(currentActiveTool.id);
    favBtn.innerHTML = `<i class="${isFav ? 'fa-solid' : 'fa-regular'} fa-star" style="color: ${isFav ? '#f59e0b' : 'inherit'}"></i> <span>${isFav ? 'Favorited' : 'Favorite'}</span>`;
}

function updateCategoryCounts() {
    const favs = getFavoritesList();
    const countAll = document.getElementById('count-all');
    if (countAll) countAll.textContent = toolsData.length;
    const countFavs = document.getElementById('count-favs');
    if (countFavs) countFavs.textContent = favs.length;
}

// Load Tools UI with Filtering & Search
function loadTools() {
    const container = document.getElementById('tools-container');
    const recommended = document.getElementById('recommended-tools');
    if (!container) return;
    container.innerHTML = '';
    if (recommended) recommended.innerHTML = '';

    const favs = getFavoritesList();
    updateCategoryCounts();

    let filteredTools = toolsData.filter(t => {
        const matchesSearch = !toolsSearchQuery || 
            t.name.toLowerCase().includes(toolsSearchQuery.toLowerCase()) || 
            (t.desc && t.desc.toLowerCase().includes(toolsSearchQuery.toLowerCase())) ||
            t.category.toLowerCase().includes(toolsSearchQuery.toLowerCase());
        
        if (!matchesSearch) return false;

        if (activeToolsCategory === 'all') return true;
        if (activeToolsCategory === 'favorites') return favs.includes(t.id);
        if (activeToolsCategory === 'writing') return t.category.toLowerCase().includes('writing') || t.category.toLowerCase().includes('language');
        if (activeToolsCategory === 'math-science') return t.category.toLowerCase().includes('stem') || t.category.toLowerCase().includes('math') || t.category.toLowerCase().includes('science');
        if (activeToolsCategory === 'coding') return t.category.toLowerCase().includes('code') || t.category.toLowerCase().includes('tech');
        if (activeToolsCategory === 'productivity') return t.category.toLowerCase().includes('productivity') || t.category.toLowerCase().includes('task');
        if (activeToolsCategory === 'study') return t.category.toLowerCase().includes('study') || t.category.toLowerCase().includes('exam');
        return true;
    });

    if (filteredTools.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; padding: 48px 20px; color: var(--text-secondary);">
                <i class="fa-solid fa-magnifying-glass" style="font-size: 32px; color: #BFDBFE; margin-bottom: 12px; display: block;"></i>
                <h4 style="font-size: 16px; font-weight: 700; color: var(--text-primary); margin-bottom: 6px;">No tools found</h4>
                <p style="font-size: 13px;">Try searching for a different keyword or select "All Tools".</p>
            </div>
        `;
        return;
    }

    const categories = [...new Set(filteredTools.map(t => t.category))];

    categories.forEach(cat => {
        const catDiv = document.createElement('div');
        catDiv.className = 'tools-category';
        catDiv.innerHTML = `<h3>${cat}</h3><div class="tools-grid"></div>`;
        container.appendChild(catDiv);

        const grid = catDiv.querySelector('.tools-grid');
        const catTools = filteredTools.filter(t => t.category === cat);

        catTools.forEach(tool => {
            const card = createToolCard(tool);
            grid.appendChild(card);
            
            // Add some to recommended
            if (recommended && ['essay-writer', 'math-solver', 'todo-ai', 'ai-tutor'].includes(tool.id)) {
                recommended.appendChild(createToolCard(tool));
            }
        });
    });
}

function createToolCard(tool) {
    const favs = getFavoritesList();
    const isFav = favs.includes(tool.id);

    const card = document.createElement('div');
    card.className = 'tool-card glass';
    
    card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
            <div class="tool-icon"><i class="${tool.icon}"></i></div>
            <div style="display: flex; align-items: center; gap: 6px;">
                <button class="tool-fav-star" title="${isFav ? 'Favorited' : 'Add to Favorites'}" style="background: none; border: none; font-size: 14px; cursor: pointer; color: ${isFav ? '#f59e0b' : '#cbd5e1'}; padding: 4px;">
                    <i class="${isFav ? 'fa-solid' : 'fa-regular'} fa-star"></i>
                </button>
            </div>
        </div>
        <h4>${tool.name}</h4>
        <p>${tool.desc}</p>
    `;

    const favStar = card.querySelector('.tool-fav-star');
    if (favStar) {
        favStar.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFavoriteTool(tool.id);
        });
    }

    card.addEventListener('click', () => openTool(tool));
    return card;
}

function openTool(tool, updateUrl = true) {
    currentActiveTool = tool;
    sections.forEach(s => s.classList.remove('active'));
    document.getElementById('active-tool').classList.add('active');
    if (updateUrl) syncUrl(`/tool/${tool.id}`);
    
    const iconEl = document.getElementById('active-tool-icon');
    if (iconEl) iconEl.className = tool.icon || 'fa-solid fa-robot';
    const nameEl = document.getElementById('active-tool-name');
    if (nameEl) nameEl.textContent = tool.name;
    const descEl = document.getElementById('active-tool-desc');
    if (descEl) descEl.textContent = tool.desc || 'AI Study Assistant';
    
    updateActiveToolFavBtn();

    // Populate Preset Prompts
    const presetsContainer = document.getElementById('tool-presets-pills');
    const presetsWrap = document.getElementById('tool-presets-wrap');
    if (presetsContainer && presetsWrap) {
        const presets = TOOL_PRESETS[tool.id] || [];
        if (presets.length > 0) {
            presetsWrap.style.display = 'flex';
            presetsContainer.innerHTML = presets.map(p => `
                <button class="tool-preset-chip" data-prompt="${encodeURIComponent(p)}">${p.length > 35 ? p.substring(0, 32) + '...' : p}</button>
            `).join('');

            presetsContainer.querySelectorAll('.tool-preset-chip').forEach(btn => {
                btn.addEventListener('click', () => {
                    const promptText = decodeURIComponent(btn.getAttribute('data-prompt'));
                    const textarea = document.getElementById('tool-input') || document.querySelector('#tool-inputs-container textarea');
                    if (textarea) {
                        textarea.value = promptText;
                        textarea.dispatchEvent(new Event('input', { bubbles: true }));
                        textarea.focus();
                    }
                });
            });
        } else {
            presetsWrap.style.display = 'none';
        }
    }

    const inputArea = document.getElementById('tool-inputs-container') || document.querySelector('.tool-input-area');
    inputArea.innerHTML = '';
    if (tool.id === 'ai-tutor') window.ncertTutor.mount(inputArea, authToken);
    
    if (tool.inputs) {
        tool.inputs.forEach(inp => {
            const group = document.createElement('div');
            group.className = 'form-group';
            group.style.marginBottom = '14px';
            
            const label = document.createElement('label');
            label.textContent = inp.label;
            label.style.display = 'block';
            label.style.marginBottom = '8px';
            label.style.fontWeight = '600';
            label.style.fontSize = '13px';
            label.style.color = 'var(--text-primary)';
            group.appendChild(label);
            
            if (inp.type === 'select') {
                const select = document.createElement('select');
                select.id = `input-${inp.id}`;
                select.style.width = '100%';
                select.style.padding = '12px 16px';
                select.style.borderRadius = '10px';
                select.style.border = '1.5px solid var(--border-color)';
                select.style.background = 'var(--bg-color)';
                select.style.color = 'var(--text-primary)';
                select.style.fontSize = '14px';
                inp.options.forEach(opt => {
                    const option = document.createElement('option');
                    option.value = opt;
                    option.textContent = opt;
                    select.appendChild(option);
                });
                group.appendChild(select);
            } else if (inp.type === 'textarea') {
                const textarea = document.createElement('textarea');
                textarea.id = `input-${inp.id}`;
                textarea.style.width = '100%';
                textarea.style.padding = '14px 16px';
                textarea.style.borderRadius = '10px';
                textarea.style.border = '1.5px solid var(--border-color)';
                textarea.style.background = 'var(--bg-color)';
                textarea.style.color = 'var(--text-primary)';
                textarea.style.fontSize = '14px';
                textarea.style.minHeight = '120px';
                textarea.style.resize = 'vertical';
                if (tool.id === 'math-solver') {
                    textarea.style.minHeight = '160px';
                    textarea.style.fontSize = '15px';
                    textarea.style.lineHeight = '1.5';
                }
                enableAutoGrow(textarea);
                group.appendChild(textarea);
            } else if (inp.type === 'file') {
                const fileWrap = document.createElement('div');
                fileWrap.style.display = 'flex';
                fileWrap.style.flexDirection = 'column';
                fileWrap.style.gap = '6px';

                const input = document.createElement('input');
                input.type = 'file';
                input.id = `input-${inp.id}`;
                if (inp.accept) input.accept = inp.accept;
                input.style.width = '100%';
                input.style.padding = '10px 14px';
                input.style.borderRadius = '10px';
                input.style.border = '1.5px dashed var(--border-color)';
                input.style.background = 'var(--bg-color)';
                input.style.color = 'var(--text-primary)';
                input.style.fontSize = '13px';
                fileWrap.appendChild(input);
                group.appendChild(fileWrap);
            } else {
                const input = document.createElement('input');
                input.type = inp.type;
                input.id = `input-${inp.id}`;
                input.style.width = '100%';
                input.style.padding = '12px 16px';
                input.style.borderRadius = '10px';
                input.style.border = '1.5px solid var(--border-color)';
                input.style.background = 'var(--bg-color)';
                input.style.color = 'var(--text-primary)';
                input.style.fontSize = '14px';
                group.appendChild(input);
            }
            inputArea.appendChild(group);
        });
    } else {
        const textarea = document.createElement('textarea');
        textarea.id = 'tool-input';
        textarea.placeholder = tool.prompt || 'Enter your question or prompt here...';
        textarea.style.width = '100%';
        textarea.style.padding = '14px 16px';
        textarea.style.borderRadius = '10px';
        textarea.style.border = '1.5px solid var(--border-color)';
        textarea.style.background = 'var(--bg-color)';
        textarea.style.color = 'var(--text-primary)';
        textarea.style.minHeight = '120px';
        textarea.style.fontSize = '14px';
        textarea.style.resize = 'vertical';
        enableAutoGrow(textarea);
        inputArea.appendChild(textarea);
    }
    
    const runBtn = document.getElementById('run-tool-btn');
    if (runBtn && inputArea.parentElement && !inputArea.parentElement.contains(runBtn)) {
        inputArea.parentElement.appendChild(runBtn);
    }
    document.getElementById('tool-output').textContent = 'Output will appear here...';
}

document.getElementById('back-to-tools').addEventListener('click', () => {
    sections.forEach(s => s.classList.remove('active'));
    document.getElementById('tools').classList.add('active');
    navItems.forEach(n => n.classList.remove('active'));
    document.querySelector('.nav-item[data-target="tools"]').classList.add('active');
});

// Run AI Tool
document.getElementById('run-tool-btn').addEventListener('click', async () => {
    if (!currentActiveTool || !authToken) return;
    
    let fullPrompt = '';
    
    if (currentActiveTool.inputs) {
        const vals = {};
        for (const inp of currentActiveTool.inputs) {
            const el = document.getElementById(`input-${inp.id}`);
            if (inp.type === 'file') {
                if (el.files && el.files[0]) {
                    document.getElementById('tool-output').innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Reading file...';
                    vals[inp.id] = await extractTextFromFile(el.files[0]);
                } else {
                    vals[inp.id] = '';
                }
            } else {
                vals[inp.id] = el.value;
            }
        }
        fullPrompt = currentActiveTool.promptTemplate(vals);
    } else {
        const input = document.getElementById('tool-input').value;
        if (!input) return;
        fullPrompt = `${currentActiveTool.prompt} ${input}`;
    }

    const outputArea = document.getElementById('tool-output');
    outputArea.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating...';
    
    try {
        let response;
        if (currentActiveTool.id === 'ai-tutor') {
            if (window.ncertTutor.active()) {
                response = await window.ncertTutor.ask(authToken, document.getElementById('input-topic').value);
                await renderWithTyping(outputArea, response.result, { renderMath: true });
                // matchedChapter names the chapter the corpus picked, so the
                // student can see which textbook the answer came from.
                window.ncertTutor.showSources(outputArea, response.sources,
                    response.grounded && response.matchedChapter
                        ? [response.matchedBook, response.matchedChapter].filter(Boolean).join(' — ')
                        : null);
            } else {
            if (!window.aiTutorMemory) {
                window.aiTutorMemory = [{ role: 'system', content: 'You are an expert AI Tutor. Be extremely helpful and encouraging. Remember the context of our conversation.' }];
            }
            window.aiTutorMemory.push({ role: 'user', content: fullPrompt });
            response = await api.generateAIChat(authToken, window.aiTutorMemory);
            window.aiTutorMemory.push({ role: 'assistant', content: response.result });
            
            // Render as markdown to handle code/math better
            await renderWithTyping(outputArea, response.result, { renderMath: true });
            }
        } else {
            // Math solver: use Gemini 2.5 Pro for accurate step-by-step reasoning
            if (currentActiveTool.id === 'math-solver') {
                const sys = currentActiveTool.systemMessage || 'You are a helpful math teacher.';
                const mathModel = 'gemini-2.5-pro';
                const memory = [
                    { role: 'system', content: sys },
                    { role: 'user', content: fullPrompt }
                ];

                response = await api.generateAIChat(authToken, memory, sys, mathModel);
                memory.push({ role: 'assistant', content: response.result });

                let combined = String(response.result || '');
                let safety = 0;
                while (!combined.includes('\nEND') && !combined.trim().endsWith('END') && safety < 3) {
                    safety += 1;
                    memory.push({
                        role: 'user',
                        content: 'Continue exactly where you left off. Do NOT repeat. Finish with FINAL ANSWER and END.'
                    });
                    const cont = await api.generateAIChat(authToken, memory, sys, mathModel);
                    memory.push({ role: 'assistant', content: cont.result });
                    combined += '\n' + String(cont.result || '');
                }

                await renderWithTyping(outputArea, combined, { renderMath: true });
            } else {
                response = await api.generateAI(
                    authToken,
                    fullPrompt,
                    currentActiveTool.systemMessage || `You are an expert in ${currentActiveTool.category}. Provide concise, accurate output.`
                );
                await renderWithTyping(outputArea, response.result, { renderMath: false });
            }
        }
        
        // Keep newest content visible for long solutions.
        outputArea.scrollTop = 0;
        
        const xpRes = await api.addXp(authToken, 10, 1, currentActiveTool.name);
        applyXpResult(xpRes);
        recordActivity(currentActiveTool.name, currentActiveTool.icon, 10);
    } catch (err) {
        outputArea.textContent = currentActiveTool?.id === 'ai-tutor' && window.ncertTutor.active()
            ? (err.message || 'Textbook answers are temporarily unavailable.')
            : 'Error connecting to AI service.';
    }
});

// Output Action Handlers
document.getElementById('copy-output-btn')?.addEventListener('click', () => {
    const text = document.getElementById('tool-output')?.innerText || '';
    if (!text || text === 'Output will appear here...') {
        return showToast('No output to copy', 'info');
    }
    navigator.clipboard.writeText(text).then(() => {
        showToast('Output copied to clipboard!', 'success');
        const btn = document.getElementById('copy-output-btn');
        if (btn) {
            const orig = btn.innerHTML;
            btn.innerHTML = '<i class="fa-solid fa-check"></i> <span>Copied!</span>';
            setTimeout(() => { btn.innerHTML = orig; }, 2000);
        }
    }).catch(() => {
        showToast('Failed to copy text', 'error');
    });
});

document.getElementById('save-output-note-btn')?.addEventListener('click', async () => {
    const text = document.getElementById('tool-output')?.innerText || '';
    if (!text || text === 'Output will appear here...') {
        return showToast('No output to save', 'info');
    }
    const title = currentActiveTool ? `${currentActiveTool.name} Notes` : 'AI Study Note';
    try {
        await api.saveNote(authToken, title, text);
        showToast('Saved to your Notes!', 'success');
        loadNotes();
    } catch (err) {
        showToast('Failed to save note', 'error');
    }
});

document.getElementById('clear-output-btn')?.addEventListener('click', () => {
    const out = document.getElementById('tool-output');
    if (out) out.textContent = 'Output will appear here...';
    showToast('Output cleared', 'info');
});

function showToast(msg, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast-item toast-${type}`;
    let icon = 'fa-solid fa-circle-info';
    if (type === 'success') icon = 'fa-solid fa-circle-check';
    if (type === 'error') icon = 'fa-solid fa-circle-exclamation';
    
    toast.innerHTML = `<i class="${icon}"></i> <span>${escapeHtml(msg)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('toast-fadeout');
        setTimeout(() => toast.remove(), 320);
    }, 2800);
}

async function extractTextFromFile(file) {
    if (!file) return '';
    
    // Plain Text / Subtitles
    if (file.type === 'text/plain' || file.name.match(/\.(txt|vtt|srt|csv)$/i)) {
        return await file.text();
    }
    
    // PDF
    if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
        if (!window.pdfjsLib) return 'Error: PDF.js not loaded';
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
        
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await window.pdfjsLib.getDocument(arrayBuffer).promise;
        let fullText = '';
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            fullText += textContent.items.map(s => s.str).join(' ') + '\n';
        }
        return fullText;
    }
    
    // Image OCR
    if (file.type.startsWith('image/')) {
        if (!window.Tesseract) return 'Error: Tesseract not loaded';
        document.getElementById('tool-output').innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Extracting text from image...';
        const result = await window.Tesseract.recognize(file, 'eng');
        return result.data.text;
    }
    
    return 'Unsupported file type.';
}

// Notes Logic
async function loadNotes() {
    try {
        const notes = await api.getNotes(authToken);
        const list = document.getElementById('notes-list');
        list.innerHTML = '';
        
        notes.forEach(note => {
            const div = document.createElement('div');
            div.className = 'note-item';
            div.innerHTML = `<h4>${note.title}</h4><p>${new Date(note.created_at).toLocaleDateString()}</p>`;
            div.addEventListener('click', () => {
                document.getElementById('note-title').value = note.title;
                document.getElementById('note-content').value = note.content;
                document.querySelectorAll('.note-item').forEach(n => n.classList.remove('active'));
                div.classList.add('active');
            });
            list.appendChild(div);
        });
    } catch (err) {
        console.error(err);
    }
}

document.getElementById('save-note-btn').addEventListener('click', async () => {
    const title = document.getElementById('note-title').value;
    const content = document.getElementById('note-content').value;
    
    if (!title || !content) {
        alert("Please provide both title and content.");
        return;
    }
    
    try {
        await api.saveNote(authToken, title, content);
        const noteXp = await api.addXp(authToken, 5, 2, 'Note Taker');
        applyXpResult(noteXp);
        recordActivity('Saved Note: ' + title.slice(0, 30), 'fa-solid fa-book', 5);
        document.getElementById('note-title').value = '';
        document.getElementById('note-content').value = '';
        loadNotes();
    } catch (err) {
        alert("Failed to save note");
    }
});

document.getElementById('summarize-note-btn').addEventListener('click', async () => {
    const content = document.getElementById('note-content').value;
    if (!content) return;
    
    document.getElementById('note-content').value = "Summarizing... Please wait.";
    try {
        const response = await api.generateAI(authToken, `Summarize this text in bullet points: ${content}`, "You are a summarizing assistant.");
        document.getElementById('note-content').value = response.result;
    } catch (err) {
        document.getElementById('note-content').value = "Failed to summarize.";
    }
});

// Leaderboard Logic
async function loadLeaderboard() {
    try {
        const data = await api.getLeaderboard(authToken);
        const leaders = data.leaders || data; // backward compat
        const currentUserRank = data.currentUserRank || null;
        const list = document.getElementById('leaderboard-list');
        list.innerHTML = '';

        function buildRow(user, index, rankLabel) {
            const div = document.createElement('div');
            const isMe = currentUserData && user.id === currentUserData.id;
            div.className = `leaderboard-item ${index < 3 ? 'top-3' : ''} ${isMe ? 'leaderboard-me' : ''}`;
            const avatarUrl = resolveAvatarUrl(user.profile_picture, user);
            const medal = rankLabel !== undefined ? rankLabel : (['🥇','🥈','🥉'][index] || `#${index+1}`);
            div.innerHTML = `
                <div class="lb-user">
                    <div class="rank">${medal}</div>
                    <img src="${avatarUrl}" alt="${user.username}" style="background:#1a1a2e; width: 40px; height: 40px; border-radius: 50%;">
                    <div>
                        <div style="font-weight: 600; font-size: 16px;">${user.username}${isMe ? ' <span style="color:#a855f7">✨ You</span>' : ''}</div>
                        ${user.bio ? `<div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">${user.bio}</div>` : ''}
                    </div>
                </div>
                <div class="lb-stats">
                    <span class="lb-level">Lvl ${user.level}</span>
                    <span class="lb-xp">${(user.xp || 0).toLocaleString()} XP</span>
                </div>
            `;
            return div;
        }

        leaders.forEach((user, index) => list.appendChild(buildRow(user, index)));

        // If current user is not in the top list, show them separately
        if (currentUserRank) {
            const sep = document.createElement('div');
            sep.style.cssText = 'text-align:center; padding: 8px 0; color: var(--text-secondary); font-size:13px; border-top: 1px solid var(--border-color); margin-top: 8px;';
            sep.textContent = '— Your Position —';
            list.appendChild(sep);
            list.appendChild(buildRow(currentUserRank, -1, `#${currentUserRank.rank}`));
        }
    } catch (err) {
        console.error(err);
    }
}

// Markdown from the models is rendered in several places. Configure it
// once: GFM tables, and single newlines become line breaks — models write
// prose with hard wraps and without this it collapses into a wall of text.
if (typeof marked !== 'undefined' && marked.setOptions) {
    marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });
}

// Theme Toggle — persisted, applied to both <html> and <body> so the
// page chrome (scrollbars, overscroll area) matches the app surface.
function applyTheme(theme) {
    const isDark = theme === 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    document.body.setAttribute('data-theme', theme);

    // Every portal has its own toggle button; keep all their icons in sync.
    document.querySelectorAll('#theme-icon, .theme-icon').forEach((icon) => {
        icon.className = (isDark ? 'fa-solid fa-moon' : 'fa-solid fa-sun') +
            (icon.id === 'theme-icon' ? '' : ' theme-icon');
    });

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', isDark ? '#0A1120' : '#F4F7FC');

    document.querySelectorAll('#theme-toggle, [data-theme-toggle]').forEach((btn) => {
        btn.setAttribute('aria-pressed', String(isDark));
        btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
    });
}

function initTheme() {
    let stored = null;
    try { stored = localStorage.getItem('theme'); } catch (e) { /* private mode */ }
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(stored || (prefersDark ? 'dark' : 'light'));
}

initTheme();

// Delegated so any portal's toggle works, including markup added later.
document.addEventListener('click', (e) => {
    if (!e.target.closest('#theme-toggle, [data-theme-toggle]')) return;
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('theme', next); } catch (err) { /* private mode */ }
});

// Focus Timer Logic
let timerInterval;
let timeLeft = 25 * 60; // 25 minutes
let isTimerRunning = false;

const timerDisplay = document.getElementById('timer-display');
const startTimerBtn = document.getElementById('start-timer');
const resetTimerBtn = document.getElementById('reset-timer');

function updateTimerDisplay() {
    const minutes = Math.floor(timeLeft / 60);
    const seconds = timeLeft % 60;
    timerDisplay.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

startTimerBtn.addEventListener('click', () => {
    if (isTimerRunning) {
        clearInterval(timerInterval);
        startTimerBtn.innerHTML = '<i class="fa-solid fa-play"></i> Start Focus';
        isTimerRunning = false;
    } else {
        isTimerRunning = true;
        startTimerBtn.innerHTML = '<i class="fa-solid fa-pause"></i> Pause';
        timerInterval = setInterval(async () => {
            timeLeft--;
            updateTimerDisplay();
            
            if (timeLeft <= 0) {
                clearInterval(timerInterval);
                isTimerRunning = false;
                startTimerBtn.innerHTML = '<i class="fa-solid fa-play"></i> Start Focus';
                alert('Focus session complete! Take a break.');
                if (authToken) {
                    const xpRes = await api.addXp(authToken, 50, 25, 'Focus Timer');
                    applyXpResult(xpRes);
                    recordActivity('Completed Focus Session', 'fa-solid fa-stopwatch', 50);
                }
                timeLeft = 25 * 60;
                updateTimerDisplay();
            }
        }, 1000);
    }
});

document.getElementById('reset-timer').addEventListener('click', () => {
    clearInterval(timerInterval);
    isTimerRunning = false;
    startTimerBtn.innerHTML = '<i class="fa-solid fa-play"></i> Start Focus';
    timeLeft = 25 * 60;
    updateTimerDisplay();
});

// Run Init
initApp();

// --- Worksheet Logic ---
let currentWorksheetQuestions = [];

function extractJsonPayload(text, isArray = true) {
    if (!text) return isArray ? [] : {};
    let clean = String(text).replace(/```json/gi, '').replace(/```/gi, '').trim();
    try {
        return JSON.parse(clean);
    } catch (e) {
        const startChar = isArray ? '[' : '{';
        const endChar = isArray ? ']' : '}';
        const firstIdx = clean.indexOf(startChar);
        const lastIdx = clean.lastIndexOf(endChar);
        if (firstIdx !== -1 && lastIdx !== -1 && lastIdx > firstIdx) {
            const sub = clean.substring(firstIdx, lastIdx + 1);
            return JSON.parse(sub);
        }
        throw e;
    }
}

function getQuestionOptions(q, type) {
    if (type === 'True/False') {
        return ['True', 'False'];
    }

    let opts = [];
    if (Array.isArray(q.options) && q.options.length > 0) {
        opts = q.options.map(o => String(o).trim());
    } else if (Array.isArray(q.choices) && q.choices.length > 0) {
        opts = q.choices.map(o => String(o).trim());
    } else if (q.options && typeof q.options === 'object') {
        opts = Object.values(q.options).map(o => String(o).trim());
    } else if (q.choices && typeof q.choices === 'object') {
        opts = Object.values(q.choices).map(o => String(o).trim());
    }

    // If options are still empty for Multiple Choice, try to parse options from question string
    if (opts.length < 2 && type === 'Multiple Choice' && typeof q.question === 'string') {
        const optionRegex = /(?:^|\s)(?:[A-Da-d][\.\)]|\([A-Da-d]\))\s+([^A-Da-d\.\)\n\r]+)/g;
        const matches = [];
        let m;
        while ((m = optionRegex.exec(q.question)) !== null) {
            const val = m[1].trim();
            if (val) matches.push(val);
        }
        if (matches.length >= 2) {
            const firstLetterIdx = q.question.search(/(?:^|\s)(?:[A-Da-d][\.\)]|\([A-Da-d]\))\s+/);
            if (firstLetterIdx > 5) {
                q.question = q.question.substring(0, firstLetterIdx).trim();
            }
            opts = matches;
        }
    }

    return opts;
}

let wsTimerInterval = null;

function updateWorksheetProgress() {
    if (!currentWorksheetQuestions || currentWorksheetQuestions.length === 0) return;
    const total = currentWorksheetQuestions.length;
    let answeredCount = 0;

    currentWorksheetQuestions.forEach((q, idx) => {
        const qId = q.id || (idx + 1);
        const radio = document.querySelector(`input[name="q_${qId}"]:checked`);
        const txt = document.getElementById(`q_${qId}`);
        const pill = document.getElementById(`ws-nav-pill-${idx + 1}`);

        const isAnswered = Boolean(radio || (txt && txt.value.trim().length > 0));
        if (isAnswered) {
            answeredCount++;
            if (pill) pill.classList.add('answered');
        } else {
            if (pill) pill.classList.remove('answered');
        }
    });

    const pct = Math.round((answeredCount / total) * 100);
    const label = document.getElementById('ws-progress-label');
    const fill = document.getElementById('ws-progress-fill');
    if (label) label.textContent = `Answered: ${answeredCount} / ${total} (${pct}%)`;
    if (fill) fill.style.width = `${pct}%`;
}

function startWorksheetTimer(durationSeconds = 600) {
    if (wsTimerInterval) clearInterval(wsTimerInterval);
    const timerBadge = document.getElementById('ws-exam-timer-badge');
    const timerDisplay = document.getElementById('ws-exam-time-left');
    if (!timerBadge || !timerDisplay) return;

    let timeLeft = durationSeconds;
    timerBadge.style.display = 'inline-flex';

    function renderTime() {
        const mins = Math.floor(timeLeft / 60);
        const secs = timeLeft % 60;
        timerDisplay.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    renderTime();

    wsTimerInterval = setInterval(() => {
        timeLeft--;
        if (timeLeft <= 0) {
            clearInterval(wsTimerInterval);
            renderTime();
            alert('⏱️ Exam time is up! Auto-submitting your worksheet for grading...');
            document.getElementById('submit-ws-btn')?.click();
        } else {
            renderTime();
        }
    }, 1000);
}

function stopWorksheetTimer() {
    if (wsTimerInterval) {
        clearInterval(wsTimerInterval);
        wsTimerInterval = null;
    }
}

document.getElementById('generate-ws-btn').addEventListener('click', async () => {
    const cls = document.getElementById('ws-class').value;
    const topic = document.getElementById('ws-topic').value;
    const type = document.getElementById('ws-type').value;
    const difficulty = document.getElementById('ws-difficulty')?.value || 'Medium / Standard';
    const count = document.getElementById('ws-count').value || 5;
    const isTimed = document.getElementById('ws-timed-toggle')?.checked ?? true;
    const customMins = parseInt(document.getElementById('ws-student-custom-mins')?.value) || 10;
    const status = document.getElementById('ws-gen-status');
    
    if (!cls || !topic) return alert('Please enter Class and Topic.');
    
    status.style.display = 'block';
    status.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating custom worksheet with GPT-OSS 120B...';
    document.getElementById('worksheet-interactive-area').style.display = 'none';
    document.getElementById('ws-grading-area').style.display = 'none';
    stopWorksheetTimer();
    
    let typeInstructions = '';
    if (type === 'Multiple Choice') {
        typeInstructions = 'For EVERY question, you MUST provide an "options" array with exactly 4 distinct choices as strings. Do NOT embed option letters or choices inside the "question" string.';
    } else if (type === 'True/False') {
        typeInstructions = 'For EVERY question, "options" MUST be ["True", "False"].';
    } else {
        typeInstructions = 'For short answer questions, "options" can be empty [].';
    }

    const prompt = `Generate a ${count}-question worksheet for ${cls} students about "${topic}". 
The question type is "${type}" and difficulty level is "${difficulty}".
${typeInstructions}

You MUST return ONLY a valid JSON array of objects. Do not include markdown formatting or commentary.
Format:
[
  {
    "id": 1,
    "question": "Question text",
    "options": ${type === 'Multiple Choice' ? '["Choice A", "Choice B", "Choice C", "Choice D"]' : type === 'True/False' ? '["True", "False"]' : '[]'},
    "correct_answer": "The correct answer"
  }
]`;
    
    try {
        const response = await api.generateAI(authToken, prompt, "You are a teacher formatting output strictly as JSON.");
        const questions = extractJsonPayload(response.result, true);
        currentWorksheetQuestions = questions;
        
        document.getElementById('ws-title').textContent = `${topic} • ${difficulty} (${type})`;
        const container = document.getElementById('ws-questions-container');
        container.innerHTML = '';
        
        const navPillsContainer = document.getElementById('ws-q-nav-pills');
        if (navPillsContainer) navPillsContainer.innerHTML = '';

        questions.forEach((q, idx) => {
            const qId = q.id || (idx + 1);
            const qNum = idx + 1;
            const div = document.createElement('div');
            div.className = 'ws-question-card glass';
            div.id = `ws-q-card-${qNum}`;
            
            const rawQuestion = String(q.question || '');
            const questionTitleHtml = escapeHtml(rawQuestion);
            
            let html = `
                <div class="ws-q-header">
                    <span class="ws-q-number">Q${qNum}</span>
                    <h4 class="ws-q-text">${questionTitleHtml}</h4>
                </div>
            `;
            
            const opts = getQuestionOptions(q, type);
            if (opts && opts.length > 0) {
                html += `<div class="ws-options-grid">`;
                opts.forEach((opt, optIdx) => {
                    const optLetter = String.fromCharCode(65 + optIdx);
                    const cleanText = String(opt).replace(/^[A-Da-d][\.\)]\s*/, '').trim() || String(opt);
                    const escapedValue = escapeHtml(cleanText);
                    const optId = `opt_${qId}_${optIdx}`;
                    
                    html += `
                        <label class="ws-option-pill" for="${optId}">
                            <input type="radio" id="${optId}" name="q_${qId}" value="${escapedValue}" class="ws-radio-input">
                            <span class="ws-opt-badge">${optLetter}.</span>
                            <span class="ws-opt-text">${escapedValue}</span>
                        </label>
                    `;
                });
                html += `</div>`;
            } else {
                html += `<input type="text" id="q_${qId}" class="ws-text-answer" placeholder="Type your answer here...">`;
            }
            
            div.innerHTML = html;

            // Highlight selected pill on click and update progress
            const radioInputs = div.querySelectorAll('.ws-radio-input');
            radioInputs.forEach(radio => {
                radio.addEventListener('change', () => {
                    div.querySelectorAll('.ws-option-pill').forEach(pill => pill.classList.remove('active-selected'));
                    if (radio.checked) {
                        radio.closest('.ws-option-pill')?.classList.add('active-selected');
                    }
                    updateWorksheetProgress();
                });
            });

            const textInput = div.querySelector('.ws-text-answer');
            if (textInput) {
                textInput.addEventListener('input', updateWorksheetProgress);
            }

            container.appendChild(div);

            // Add navigation pill
            if (navPillsContainer) {
                const navPill = document.createElement('button');
                navPill.className = 'ws-q-nav-pill';
                navPill.id = `ws-nav-pill-${qNum}`;
                navPill.textContent = qNum;
                navPill.addEventListener('click', () => {
                    document.getElementById(`ws-q-card-${qNum}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                });
                navPillsContainer.appendChild(navPill);
            }
        });
        
        updateWorksheetProgress();

        if (isTimed) {
            startWorksheetTimer(customMins * 60);
        } else {
            const timerBadge = document.getElementById('ws-exam-timer-badge');
            if (timerBadge) timerBadge.style.display = 'none';
        }

        document.getElementById('worksheet-interactive-area').style.display = 'block';
        status.style.display = 'none';
        document.getElementById('worksheet-interactive-area').scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
        console.error(err);
        status.textContent = 'Error generating worksheet. Please try again.';
    }
});

// Print Exam Paper Handler
document.getElementById('ws-print-paper-btn')?.addEventListener('click', () => {
    window.print();
});

// Retake Test Handler
document.getElementById('ws-retake-btn')?.addEventListener('click', () => {
    document.getElementById('ws-grading-area').style.display = 'none';
    document.getElementById('worksheet-interactive-area').style.display = 'block';
    
    // Clear selections
    document.querySelectorAll('.ws-radio-input').forEach(r => r.checked = false);
    document.querySelectorAll('.ws-option-pill').forEach(p => p.classList.remove('active-selected'));
    document.querySelectorAll('.ws-text-answer').forEach(t => t.value = '');
    updateWorksheetProgress();
    document.getElementById('worksheet-interactive-area').scrollIntoView({ behavior: 'smooth' });
});

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

document.getElementById('submit-ws-btn').addEventListener('click', async () => {
    const btn = document.getElementById('submit-ws-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Grading Worksheet with AI...';
    stopWorksheetTimer();
    
    // Collect answers
    let studentAnswers = [];
    currentWorksheetQuestions.forEach((q, idx) => {
        const qId = q.id || (idx + 1);
        let answer = '';
        const radio = document.querySelector(`input[name="q_${qId}"]:checked`);
        if (radio) {
            answer = radio.value;
        } else {
            const txt = document.getElementById(`q_${qId}`);
            if (txt) answer = txt.value;
        }
        studentAnswers.push({
            id: qId,
            question: q.question,
            student_answer: answer ? answer.trim() : '',
            correct_answer: q.correct_answer || ''
        });
    });
    
    const prompt = `Grade the following student worksheet answers.
You MUST return ONLY a valid JSON object. Do not include markdown formatting or commentary.
Format:
{
  "score": "X/Y (Z%)",
  "feedback": [
     {
        "id": 1,
        "question": "Question text",
        "student_answer": "Student's selected answer",
        "correct": true,
        "correct_answer": "The actual correct answer",
        "explanation": "Clear explanation"
     }
  ]
}

Student Answers:
${JSON.stringify(studentAnswers, null, 2)}
`;
    
    try {
        const response = await api.generateAI(authToken, prompt, "You are a strict teacher grading a worksheet. Output strictly JSON.");
        const grading = extractJsonPayload(response.result, false);
        
        document.getElementById('ws-score').textContent = grading.score || 'Graded';
        const fContainer = document.getElementById('ws-feedback-container');
        fContainer.innerHTML = '';
        
        if (Array.isArray(grading.feedback)) {
            grading.feedback.forEach((f, idx) => {
                const isCorrect = Boolean(f.correct);
                const originalQ = studentAnswers[idx] || {};
                const studentAns = f.student_answer || originalQ.student_answer || '(No answer provided)';
                const correctAns = f.correct_answer || originalQ.correct_answer || '';
                const questionText = f.question || originalQ.question || `Question ${idx + 1}`;

                const div = document.createElement('div');
                div.className = `ws-feedback-card glass ${isCorrect ? 'ws-fb-correct' : 'ws-fb-incorrect'}`;

                let html = `
                    <div class="ws-fb-top">
                        <div class="ws-fb-q-info">
                            <span class="ws-fb-q-num">Q${idx + 1}</span>
                            <span class="ws-fb-q-title">${escapeHtml(questionText)}</span>
                        </div>
                        <span class="ws-fb-status-pill ${isCorrect ? 'status-correct' : 'status-incorrect'}">
                            ${isCorrect ? '<i class="fa-solid fa-circle-check"></i> Correct' : '<i class="fa-solid fa-circle-xmark"></i> Incorrect'}
                        </span>
                    </div>
                    <div class="ws-fb-answers">
                        <div class="ws-fb-ans-row">
                            <span class="ws-fb-ans-label"><i class="fa-solid fa-user-check"></i> Your Selected Answer:</span>
                            <span class="ws-fb-ans-val ${isCorrect ? 'ans-correct' : 'ans-wrong'}">${escapeHtml(studentAns)}</span>
                        </div>
                `;

                if (!isCorrect && correctAns) {
                    html += `
                        <div class="ws-fb-ans-row">
                            <span class="ws-fb-ans-label"><i class="fa-solid fa-circle-check"></i> Correct Answer:</span>
                            <span class="ws-fb-ans-val ans-correct">${escapeHtml(correctAns)}</span>
                        </div>
                    `;
                }

                html += `</div>`;

                if (f.explanation) {
                    html += `
                        <div class="ws-fb-explanation">
                            <i class="fa-solid fa-lightbulb"></i>
                            <div>
                                <strong>Explanation: </strong>
                                <span>${escapeHtml(f.explanation)}</span>
                            </div>
                        </div>
                    `;
                }

                div.innerHTML = html;
                fContainer.appendChild(div);
            });
        }
        
        document.getElementById('ws-grading-area').style.display = 'block';
        document.getElementById('ws-grading-area').scrollIntoView({ behavior: 'smooth' });
        
        api.addXp(authToken, 50, 5, 'Completed Worksheet').then(res => {
            applyXpResult(res);
            recordActivity('Completed Worksheet', 'fa-solid fa-file-pen', 50);
        });
        
    } catch (err) {
        console.error(err);
        alert('Failed to grade worksheet. AI might have returned invalid format.');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-check-double"></i> Submit Answers for AI Grading';
    }
});

// Certificate State & Handlers
let currentCertificateData = null;

document.getElementById('ws-download-cert-btn')?.addEventListener('click', () => {
    const studentName = currentUserData?.username || 'Student';
    const topic = document.getElementById('ws-topic')?.value || 'Interactive Assessment';
    const scoreText = document.getElementById('ws-score')?.textContent || '100%';
    const dateFormatted = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const certId = `SH-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

    currentCertificateData = {
        studentName,
        topic,
        score: scoreText,
        date: dateFormatted,
        id: certId
    };

    document.getElementById('cert-student-name').textContent = studentName;
    document.getElementById('cert-topic-name').textContent = topic;
    document.getElementById('cert-score-text').textContent = scoreText;
    document.getElementById('cert-date-text').textContent = dateFormatted;
    document.getElementById('cert-id-val').textContent = certId;

    document.getElementById('certificate-modal').style.display = 'flex';
});

document.getElementById('close-cert-btn')?.addEventListener('click', () => {
    document.getElementById('certificate-modal').style.display = 'none';
});

document.getElementById('print-cert-btn')?.addEventListener('click', () => {
    window.print();
});

document.getElementById('download-cert-img-btn')?.addEventListener('click', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 800;
    const ctx = canvas.getContext('2d');

    // Fill background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 1200, 800);

    // Borders
    ctx.strokeStyle = '#1e3a8a';
    ctx.lineWidth = 14;
    ctx.strokeRect(30, 30, 1140, 740);
    ctx.lineWidth = 4;
    ctx.strokeRect(48, 48, 1104, 704);

    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2;
    ctx.strokeRect(60, 60, 1080, 680);

    // Header
    ctx.fillStyle = '#2563eb';
    ctx.font = 'bold 22px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🎓 STUDYHUB ACADEMY', 600, 120);

    ctx.fillStyle = '#1e3a8a';
    ctx.font = 'bold 44px "Times New Roman", serif';
    ctx.fillText('CERTIFICATE OF ACHIEVEMENT', 600, 180);

    ctx.fillStyle = '#64748b';
    ctx.font = 'italic 20px "Times New Roman", serif';
    ctx.fillText('This certificate is proudly awarded to', 600, 230);

    // Student Name
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 48px "Times New Roman", serif';
    const sName = currentCertificateData ? currentCertificateData.studentName : 'Student Name';
    ctx.fillText(sName, 600, 310);

    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(350, 330);
    ctx.lineTo(850, 330);
    ctx.stroke();

    // Body
    ctx.fillStyle = '#475569';
    ctx.font = '22px Inter, sans-serif';
    ctx.fillText('for successfully completing the comprehensive assessment in', 600, 380);

    ctx.fillStyle = '#1e40af';
    ctx.font = 'bold 32px Inter, sans-serif';
    const sTopic = currentCertificateData ? currentCertificateData.topic : 'Assessment';
    ctx.fillText(sTopic, 600, 430);

    ctx.fillStyle = '#16a34a';
    ctx.font = 'bold 24px Inter, sans-serif';
    const sScore = currentCertificateData ? currentCertificateData.score : '100%';
    ctx.fillText(`with an official score of ${sScore}`, 600, 480);

    // Left Sig
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(180, 620);
    ctx.lineTo(380, 620);
    ctx.stroke();
    ctx.fillStyle = '#1e3a8a';
    ctx.font = 'italic 28px "Brush Script MT", cursive, serif';
    ctx.fillText('Dr. Alex Vance', 280, 605);
    ctx.fillStyle = '#64748b';
    ctx.font = 'bold 14px Inter, sans-serif';
    ctx.fillText('ACADEMIC DIRECTOR', 280, 645);

    // Right Date
    ctx.beginPath();
    ctx.moveTo(820, 620);
    ctx.lineTo(1020, 620);
    ctx.stroke();
    ctx.fillStyle = '#1e3a8a';
    ctx.font = 'bold 20px Inter, sans-serif';
    const sDate = currentCertificateData ? currentCertificateData.date : 'August 27, 2026';
    ctx.fillText(sDate, 920, 605);
    ctx.fillStyle = '#64748b';
    ctx.font = 'bold 14px Inter, sans-serif';
    ctx.fillText('DATE OF ISSUE', 920, 645);

    // Gold Seal Circle
    ctx.beginPath();
    ctx.arc(600, 600, 50, 0, Math.PI * 2);
    ctx.fillStyle = '#f59e0b';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 13px Inter, sans-serif';
    ctx.fillText('VERIFIED', 600, 605);

    // ID tag
    ctx.fillStyle = '#94a3b8';
    ctx.font = '14px Inter, sans-serif';
    const sId = currentCertificateData ? currentCertificateData.id : 'SH-2026-9821';
    ctx.fillText(`Certificate ID: ${sId} • Verified by StudyHub AI Examination Engine`, 600, 710);

    const link = document.createElement('a');
    link.download = `StudyHub-Certificate-${sName.replace(/\s+/g, '_')}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
    showToast('Certificate image downloaded!', 'success');
});

// --- AI Creative Logic ---
// ================================================================
// MERMAID: extract, repair and render AI-generated diagram code
// ----------------------------------------------------------------
// Models reliably emit labels like `H2O[Water Splitting (Photolysis)]`.
// Mermaid reads the `(` as shape syntax and throws "Syntax error in
// text", so the label has to be quoted before it ever reaches the
// parser. We extract, repair, validate, and only then render.
// ================================================================

// Pull the diagram out of whatever the model wrapped it in.
function extractMermaidCode(aiOutput) {
    const text = String(aiOutput || '');
    let code = '';

    const fenced = text.match(/```mermaid\s*([\s\S]*?)```/i);
    if (fenced) {
        code = fenced[1];
    } else {
        const anyFence = text.match(/```\s*([\s\S]*?)```/);
        if (anyFence) {
            code = anyFence[1];
        } else {
            const bare = text.match(/^\s*(graph |flowchart |sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|requirementDiagram|gitGraph|mindmap)[\s\S]*/m);
            code = bare ? bare[0] : text;
        }
    }

    code = code.trim();
    // A ```<lang> fence sometimes lands the language on its own first line.
    code = code.replace(/^(mermaid|mmd)\s*\n/i, '');
    // Strip conversational tails the model adds after the diagram.
    code = code.replace(/\n\s*(Here is your diagram|Enjoy!|Hope this helps|Let me know)[\s\S]*$/i, '');
    return code.trim();
}

// Quote a node label when it contains characters Mermaid would otherwise
// treat as syntax. Only for the shape-based diagram types — braces and
// brackets mean something different in classDiagram/sequenceDiagram, so
// touching those would break valid input.
function repairMermaidLabels(code) {
    if (!/^\s*(flowchart|graph|mindmap)\b/im.test(code)) return code;

    const PAIRS = [['[[', ']]'], ['[(', ')]'], ['([', '])'], ['((', '))'], ['{{', '}}'], ['[', ']'], ['(', ')'], ['{', '}']];
    const RISKY = /[()\[\]{}<>#]/;

    return code.split('\n').map((line) => {
        // Leave directives and styling alone.
        if (/^\s*(%%|classDef|class\s|style\s|linkStyle|click\s|direction\s)/.test(line)) return line;

        let out = '';
        let i = 0;
        while (i < line.length) {
            let matched = null;
            for (const [open, close] of PAIRS) {
                if (line.startsWith(open, i)) { matched = [open, close]; break; }
            }
            // A label opener only counts when it directly follows a node id.
            const prev = i > 0 ? line[i - 1] : '';
            if (!matched || !/[A-Za-z0-9_\-]/.test(prev)) {
                out += line[i];
                i += 1;
                continue;
            }

            const [open, close] = matched;
            // Take the first closer that is followed by a real boundary, so
            // `A[x] --> B[y]` splits correctly while `A[f(x)]` does not.
            let end = -1;
            let scan = i + open.length;
            while (scan < line.length) {
                const at = line.indexOf(close, scan);
                if (at === -1) break;
                const after = line.slice(at + close.length, at + close.length + 1);
                if (after === '' || /[\s\-=.|;&<>]/.test(after)) { end = at; break; }
                scan = at + 1;
            }
            if (end === -1) {
                out += line[i];
                i += 1;
                continue;
            }

            const label = line.slice(i + open.length, end);
            const alreadyQuoted = /^\s*".*"\s*$/.test(label);
            if (!alreadyQuoted && RISKY.test(label)) {
                out += open + '"' + label.replace(/"/g, "'") + '"' + close;
            } else {
                out += open + label + close;
            }
            i = end + close.length;
        }
        return out;
    }).join('\n');
}

// Validate, repair once, then render. Returns true on success.
async function renderMermaidDiagram(targetEl, rawCode) {
    if (typeof mermaid === 'undefined') return false;

    const attempts = [rawCode, repairMermaidLabels(rawCode)];
    let lastError = null;

    for (const candidate of attempts) {
        if (!candidate) continue;
        try {
            await mermaid.parse(candidate);
        } catch (err) {
            lastError = err;
            continue;
        }
        const id = 'mermaid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        const host = document.createElement('div');
        host.className = 'mermaid';
        host.id = id;
        // textContent, not innerHTML: labels containing < or & would
        // otherwise be parsed as markup before Mermaid ever sees them.
        host.textContent = candidate;
        targetEl.innerHTML = '';
        targetEl.appendChild(host);
        try {
            await mermaid.run({ querySelector: '#' + id });
            return true;
        } catch (err) {
            lastError = err;
        }
    }

    // Nothing parsed — show the source and the reason instead of Mermaid's
    // generic bomb graphic, so the failure is at least actionable.
    const reason = lastError ? String(lastError.message || lastError).split('\n')[0] : 'Unknown parse error';
    targetEl.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'mermaid-error';
    const title = document.createElement('p');
    title.className = 'mermaid-error-title';
    title.textContent = "Couldn't draw this diagram";
    const msg = document.createElement('p');
    msg.className = 'mermaid-error-msg';
    msg.textContent = reason;
    const pre = document.createElement('pre');
    pre.className = 'mermaid-error-code';
    pre.textContent = attempts[attempts.length - 1] || '';
    wrap.append(title, msg, pre);
    targetEl.appendChild(wrap);
    return false;
}

if (typeof mermaid !== 'undefined') {
    mermaid.initialize({ startOnLoad: false, theme: 'default' });
}

document.getElementById('generate-creative-btn').addEventListener('click', async () => {
    const promptTxt = document.getElementById('creative-prompt').value;
    const diagramType = document.getElementById('creative-type').value;
    const status = document.getElementById('creative-status');
    const container = document.getElementById('creative-output-container');
    const diagramArea = document.getElementById('creative-diagram');
    
    if (!promptTxt) return alert('Please enter a description for your diagram.');
    
    status.style.display = 'block';
    status.textContent = 'Generating visual...';
    container.style.display = 'none';
    
    if (diagramType === 'image') {
        diagramArea.innerHTML = '';
        // User explicitly chose Image Generation — always honour that.
        // (Mermaid options are available separately in the dropdown.)
        const needsCrispText = false;

        if (needsCrispText) {
            status.style.display = 'block';
            status.textContent = 'Generating crisp diagram (perfect readable text)…';

            try {
                const mermaidPrompt = `Create a clean, readable Mermaid diagram for: "${promptTxt}".\n\nRequirements:\n- Use SHORT labels (no paragraphs)\n- Use clear structure\n- Prefer flowchart or mindmap depending on what fits\n- Output ONLY a single \`\`\`mermaid\`\`\` code block, nothing else`;

                const response = await api.generateAI(
                    authToken,
                    mermaidPrompt,
                    'You generate Mermaid diagrams with very readable, minimal labels. Output only Mermaid.'
                );

                const mermaidCode = extractMermaidCode(response.result);

                container.style.display = 'block';
                status.style.display = 'none';

                await renderMermaidDiagram(diagramArea, mermaidCode);

                // Action buttons: Download SVG + View (bouncy)
                const actionsId = 'creative-image-actions';
                document.getElementById(actionsId)?.remove();
                const actions = document.createElement('div');
                actions.id = actionsId;
                actions.style.display = 'flex';
                actions.style.gap = '12px';
                actions.style.justifyContent = 'center';
                actions.style.marginTop = '14px';

                const downloadBtnEl = document.createElement('button');
                downloadBtnEl.className = 'btn btn-secondary';
                downloadBtnEl.innerHTML = '<i class="fa-solid fa-download"></i> Download SVG';

                const viewBtnEl = document.createElement('button');
                viewBtnEl.className = 'btn';
                viewBtnEl.innerHTML = '<i class="fa-solid fa-up-right-and-down-left-from-center"></i> View';
                viewBtnEl.style.animation = 'studyhub-bounce 1.4s infinite';

                actions.appendChild(downloadBtnEl);
                actions.appendChild(viewBtnEl);
                diagramArea.appendChild(actions);

                const svgEl = document.querySelector(`#${id} svg`);
                const svgText = svgEl ? new XMLSerializer().serializeToString(svgEl) : '';

                downloadBtnEl.onclick = () => {
                    const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
                    const dlUrl = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = dlUrl;
                    a.download = `studyhub-diagram-${Date.now()}.svg`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    setTimeout(() => URL.revokeObjectURL(dlUrl), 1000);
                };

                viewBtnEl.onclick = () => {
                    const modal = getOrCreateImageViewModal();
                    const modalImg = modal.querySelector('#image-view-modal-img');
                    if (modalImg) {
                        // Show SVG as data URL
                        const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
                        modalImg.src = URL.createObjectURL(svgBlob);
                        modalImg.onload = () => setTimeout(() => URL.revokeObjectURL(modalImg.src), 1500);
                    }
                    modal.style.display = 'flex';
                };

                api.addXp(authToken, 20, 5, 'AI Diagram (Crisp Text)').then(applyXpResult);

            } catch (err) {
                console.error(err);
                status.textContent = 'Failed to generate crisp diagram. Please try again.';
            }
            return;
        }

        // Image-art path (best for pictures; NOT for lots of readable text)
        const imagePrompt =
            `${promptTxt}. ` +
            `Ultra sharp, crisp, clean, high detail, high quality, sharp focus. ` +
            `No small text. No paragraphs. Aspect ratio 16:9.`;
        const encodedPrompt = encodeURIComponent(imagePrompt);
        const url = `${API_BASE_URL}/ai/image?prompt=${encodedPrompt}&model=nano-banana&width=2048&height=1152&enhance=true`;

        // Immediate "thinking" loader (ChatGPT-like) while the image provider renders.
        const loader = document.createElement('div');
        loader.style.display = 'flex';
        loader.style.flexDirection = 'column';
        loader.style.alignItems = 'center';
        loader.style.justifyContent = 'center';
        loader.style.gap = '10px';
        loader.style.padding = '26px 16px';

        loader.innerHTML = `
            <div style="display:flex; gap:10px; align-items:center;">
                <div class="studyhub-dot"></div>
                <div class="studyhub-dot"></div>
                <div class="studyhub-dot"></div>
            </div>
            <div style="color: var(--text-secondary); font-weight: 600;">Generating image…</div>
            <div style="color: var(--text-secondary); font-size: 12px; text-align:center; max-width: 520px;">
                This can take some time because the image is rendered on the server (and we request high quality).
            </div>
        `;
        diagramArea.appendChild(loader);

        // Remove old action buttons (if any) at the start of a new generation.
        const actionsId = 'creative-image-actions';
        document.getElementById(actionsId)?.remove();

        // Disable the button while generating (prevents accidental spam clicks).
        const genBtn = document.getElementById('generate-creative-btn');
        const prevBtnHtml = genBtn?.innerHTML;
        if (genBtn) {
            genBtn.disabled = true;
            genBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating…';
        }
        

        const img = document.createElement('img');
        img.style.maxWidth = '100%';
        img.style.borderRadius = '8px';
        img.style.boxShadow = '0 4px 15px rgba(0,0,0,0.2)';
        img.style.imageRendering = 'auto';

        // If provider stalls, show a helpful message instead of looking "stuck".
        let stalledTimer = setTimeout(() => {
            status.textContent = 'Still generating… (image servers can be slow). If it takes too long, try again or simplify the prompt.';
            status.style.display = 'block';
        }, 9000);
        
        img.onload = () => {
            clearTimeout(stalledTimer);
            container.style.display = 'block';
            status.style.display = 'none';
            loader.remove();
            if (genBtn) {
                genBtn.disabled = false;
                genBtn.innerHTML = prevBtnHtml || '<i class="fa-solid fa-paint-roller"></i> Generate Diagram';
            }

            // Actions: Download + View (bouncy)
            let actions = document.getElementById(actionsId);
            actions = document.createElement('div');
            actions.id = actionsId;
            actions.style.display = 'flex';
            actions.style.gap = '12px';
            actions.style.justifyContent = 'center';
            actions.style.marginTop = '14px';

            const downloadBtnEl = document.createElement('a');
            downloadBtnEl.className = 'btn btn-secondary';
            downloadBtnEl.style.textDecoration = 'none';
            downloadBtnEl.innerHTML = '<i class="fa-solid fa-download"></i> Download';

            const viewBtnEl = document.createElement('button');
            viewBtnEl.className = 'btn';
            viewBtnEl.innerHTML = '<i class="fa-solid fa-up-right-and-down-left-from-center"></i> View';
            // bounce animation
            viewBtnEl.style.animation = 'studyhub-bounce 1.4s infinite';

            actions.appendChild(downloadBtnEl);
            actions.appendChild(viewBtnEl);
            // Put buttons directly under the image area so they’re always visible.
            diagramArea.appendChild(actions);

            if (downloadBtnEl) {
                downloadBtnEl.href = img.src;
                downloadBtnEl.download = `studyhub-image-${Date.now()}.jpg`;
                downloadBtnEl.target = '_blank';
                downloadBtnEl.rel = 'noopener noreferrer';
            }
            if (viewBtnEl) {
                viewBtnEl.onclick = () => {
                    const modal = getOrCreateImageViewModal();
                    const modalImg = modal.querySelector('#image-view-modal-img');
                    if (modalImg) modalImg.src = img.src;
                    modal.style.display = 'flex';
                };
            }

            api.addXp(authToken, 20, 5, 'AI Image Generation').then(applyXpResult);
        };
        
        // ── Fallback chain: if generation fails, try backup model, then web image search ──
        const fallbackSources = [
            // 1. Backup AI model (flux)
            async () => `${API_BASE_URL}/ai/image?prompt=${encodedPrompt}&model=flux&width=1280&height=720&enhance=true`,
            // 2. Default Pollinations (no specific model)
            async () => `${API_BASE_URL}/ai/image?prompt=${encodedPrompt}&width=1280&height=720`,
            // 3. Wikipedia / Wikimedia free image search
            async () => {
                const term = encodeURIComponent(promptTxt);
                const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=${term}&gsrlimit=5&prop=pageimages&piprop=original&pilimit=5&origin=*`;
                const wRes = await fetch(wikiUrl);
                if (!wRes.ok) return null;
                const wData = await wRes.json();
                const pages = wData?.query?.pages || {};
                const found = Object.values(pages).find(p => p?.original?.source);
                return found?.original?.source || null;
            },
            // 4. Wikimedia Commons direct image search
            async () => {
                const term = encodeURIComponent(promptTxt);
                const cUrl = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrsearch=${term}&gsrlimit=5&prop=imageinfo&iiprop=url&origin=*`;
                const cRes = await fetch(cUrl);
                if (!cRes.ok) return null;
                const cData = await cRes.json();
                const pages = cData?.query?.pages || {};
                const found = Object.values(pages).find(p => p?.imageinfo?.[0]?.url);
                return found?.imageinfo?.[0]?.url || null;
            }
        ];

        let fbIdx = 0;
        img.onerror = async () => {
            while (fbIdx < fallbackSources.length) {
                const i = fbIdx++;
                try {
                    status.style.display = 'block';
                    status.textContent = i < 2
                        ? 'Image generator hiccup — trying a backup model…'
                        : 'Searching the web for a relevant image…';
                    const next = await fallbackSources[i]();
                    if (next) {
                        img.src = next;
                        return;
                    }
                } catch (_) { /* try next */ }
            }
            // All fallbacks exhausted
            clearTimeout(stalledTimer);
            loader.remove();
            if (genBtn) {
                genBtn.disabled = false;
                genBtn.innerHTML = prevBtnHtml || '<i class="fa-solid fa-paint-roller"></i> Generate Diagram';
            }
            status.textContent = 'Could not generate or find an image. Please try a simpler prompt.';
        };
        
        img.src = url;
        // Keep layout stable: append image but hide until loaded.
        img.style.display = 'none';
        diagramArea.appendChild(img);
        img.addEventListener('load', () => { img.style.display = 'block'; });

        // Add bounce keyframes once
        if (!document.getElementById('studyhub-bounce-style')) {
            const style = document.createElement('style');
            style.id = 'studyhub-bounce-style';
            style.textContent = `
@keyframes studyhub-bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
}
.studyhub-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent-primary);
  opacity: 0.35;
  animation: studyhub-dot 1s infinite ease-in-out;
}
.studyhub-dot:nth-child(2) { animation-delay: 0.15s; }
.studyhub-dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes studyhub-dot {
  0%, 100% { transform: translateY(0); opacity: 0.35; }
  50% { transform: translateY(-6px); opacity: 1; }
}
            `.trim();
            document.head.appendChild(style);
        }
        return; // Exit early since we're not using Mermaid
    }
    
    const prompt = `Generate a ${diagramType} using Mermaid.js syntax for the following description: "${promptTxt}".

RULES:
- ALWAYS wrap every node label in double quotes, e.g. A["Water Splitting (Photolysis)"]. Unquoted brackets or parentheses inside a label are a syntax error.
- Keep labels short (a few words).
- Use plain ASCII in labels; no arrows, subscripts or superscripts as characters.
- Wrap the code in a \`\`\`mermaid code block. Output nothing else — no explanation.`;
    
    try {
        const response = await api.generateAI(authToken, prompt, "You are an expert Diagram Generator. Output ONLY raw Mermaid.js syntax inside a markdown code block.");
        const mermaidCode = extractMermaidCode(response.result);

        container.style.display = 'block';
        status.style.display = 'none';

        const ok = await renderMermaidDiagram(diagramArea, mermaidCode);
        if (ok) {
            api.addXp(authToken, 20, 5, 'AI Creative Diagram').then(applyXpResult);
        }
        
    } catch (err) {
        console.error(err);
        status.textContent = 'Failed to generate diagram. Please try a simpler description.';
    }
});

// ================================================================
// WELCOME SPLASH + CONFETTI
// ================================================================

function showWelcomeSplash() {
    stopConfetti();
    const splash = document.getElementById('welcome-splash');
    if (splash) splash.style.display = 'none';
    showAppContainer();
}

function dismissSplash() {
    const splash = document.getElementById('welcome-splash');
    if (!splash || splash.style.display === 'none') return;
    stopConfetti();
    splash.style.opacity   = '0';
    splash.style.transform = 'scale(1.03)';
    setTimeout(() => {
        splash.style.display   = 'none';
        splash.style.transform = '';
        showAppContainer();
    }, 450);
}

function startConfetti() {
    const canvas = document.getElementById('confetti-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    const colors = ['#4f46e5','#8b5cf6','#ec4899','#f59e0b','#10b981','#3b82f6','#ef4444'];
    const pieces = Array.from({ length: 150 }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * -canvas.height * 0.5,
        size:     Math.random() * 9 + 5,
        speedY:   Math.random() * 3 + 2,
        speedX:   Math.random() * 2 - 1,
        rotation: Math.random() * 360,
        rotSpeed: Math.random() * 4 - 2,
        color:    colors[Math.floor(Math.random() * colors.length)],
        shape:    Math.random() > 0.4 ? 'rect' : 'circle',
        opacity:  Math.random() * 0.4 + 0.6
    }));

    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        pieces.forEach(p => {
            ctx.save();
            ctx.globalAlpha = p.opacity;
            ctx.translate(p.x + p.size / 2, p.y + p.size / 2);
            ctx.rotate(p.rotation * Math.PI / 180);
            ctx.fillStyle = p.color;
            if (p.shape === 'rect') {
                ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
            } else {
                ctx.beginPath();
                ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
            p.y += p.speedY;
            p.x += p.speedX;
            p.rotation += p.rotSpeed;
            if (p.y > canvas.height) {
                p.y = -p.size;
                p.x = Math.random() * canvas.width;
            }
        });
        confettiRAF = requestAnimationFrame(animate);
    }
    animate();
}

function stopConfetti() {
    if (confettiRAF) { cancelAnimationFrame(confettiRAF); confettiRAF = null; }
    const canvas = document.getElementById('confetti-canvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
}

function safeOn(id, event, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
    else console.warn('[safeOn] element not found:', id);
}

// ================================================================
// ADVANCED UI CAPABILITIES EVENT LISTENERS & MODULES
// ================================================================

// 1. Tools Category Filtering & Live Search
document.querySelectorAll('#tools-filter-bar .filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#tools-filter-bar .filter-pill').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        activeToolsCategory = btn.getAttribute('data-category') || 'all';
        loadTools();
    });
});

const toolsSearchEl = document.getElementById('tools-search-input');
if (toolsSearchEl) {
    toolsSearchEl.addEventListener('input', (e) => {
        toolsSearchQuery = e.target.value.trim();
        loadTools();
    });
}

// Active Tool Favorite Button
const activeToolFavBtn = document.getElementById('active-tool-fav-btn');
if (activeToolFavBtn) {
    activeToolFavBtn.addEventListener('click', () => {
        if (currentActiveTool) {
            toggleFavoriteTool(currentActiveTool.id);
        }
    });
}

// 2. Word & Character Counter for Tool Textarea
document.addEventListener('input', (e) => {
    if (e.target && (e.target.id === 'tool-input' || e.target.closest('#tool-inputs-container'))) {
        const text = e.target.value || '';
        const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
        const charCount = text.length;
        const counterEl = document.getElementById('tool-word-count');
        if (counterEl) {
            counterEl.textContent = `${wordCount} words • ${charCount} characters`;
        }
    }
    if (e.target && e.target.id === 'note-content') {
        const text = e.target.value || '';
        const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
        const statsEl = document.getElementById('note-stats-tag');
        if (statsEl) statsEl.textContent = `${wordCount} words`;
    }
});

// 3. Text-to-Speech (TTS) Reader — encouraging AI read-aloud voice (Sarvam AI)
const ttsBtn = document.getElementById('tts-output-btn');
if (ttsBtn) {
    ttsBtn.addEventListener('click', async () => {
        const text = document.getElementById('tool-output')?.innerText || '';
        if (!text || text === 'Output will appear here...') {
            return showToast('No text to read aloud', 'info');
        }

        const defaultHtml = '<i class="fa-solid fa-volume-high"></i> <span>Listen Aloud</span>';
        if (globalVoicePlayer.currentBtn === ttsBtn && globalVoicePlayer.isPlaying()) {
            globalVoicePlayer.stop();
            showToast('Voice playback stopped', 'info');
            return;
        }

        ttsBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Getting your voice ready...</span>';
        try {
            const studentName = getCleanStudentName();
            const ttsRes = await api.textToSpeech(authToken, text, 'hi-IN', 'shubh', 1.05, studentName);
            if (ttsRes.success && ttsRes.audio) {
                ttsBtn.innerHTML = '<i class="fa-solid fa-circle-stop fa-fade" style="color:#EF4444;"></i> <span>Stop Voice</span>';
                showToast("Here we go — reading it aloud for you 🔊", 'info');
                globalVoicePlayer.play(ttsRes.audio, ttsBtn, defaultHtml);
            } else {
                throw new Error('TTS service returned empty audio');
            }
        } catch (err) {
            console.error('TTS error:', err);
            ttsBtn.innerHTML = defaultHtml;
            showToast("Voice playback isn't available right now — please try again in a moment.", 'error');
        }
    });
}

// 4. Download Output as .txt
const downloadTxtBtn = document.getElementById('download-output-txt-btn');
if (downloadTxtBtn) {
    downloadTxtBtn.addEventListener('click', () => {
        const text = document.getElementById('tool-output')?.innerText || '';
        if (!text || text === 'Output will appear here...') {
            return showToast('No content to download', 'info');
        }
        const toolName = currentActiveTool ? currentActiveTool.name.replace(/[^a-zA-Z0-9]/g, '_') : 'AI_Study_Result';
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${toolName}_${Date.now()}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('Downloaded text file!', 'success');
    });
}

// 5. Inspiration Chips Handler (Worksheets & Diagrams)
document.querySelectorAll('.insp-chip').forEach(chip => {
    chip.addEventListener('click', () => {
        const topic = chip.getAttribute('data-topic');
        const cls = chip.getAttribute('data-class');
        const creativeSample = chip.getAttribute('data-creative-sample');
        const creativeType = chip.getAttribute('data-type');

        if (topic) {
            const topicInput = document.getElementById('ws-topic');
            const classInput = document.getElementById('ws-class');
            if (topicInput) topicInput.value = topic;
            if (classInput && cls) classInput.value = cls;
            showToast(`Loaded topic: ${topic}`, 'info');
        }

        if (creativeSample) {
            const promptInput = document.getElementById('creative-prompt');
            const typeInput = document.getElementById('creative-type');
            if (promptInput) promptInput.value = creativeSample;
            if (typeInput && creativeType) typeInput.value = creativeType;
            showToast(`Loaded diagram prompt: ${creativeSample}`, 'info');
        }
    });
});

// 6. AI Multi-Format Summarizer Studio
const sumTabs = document.querySelectorAll('.sum-tab');
sumTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        sumTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const mode = tab.getAttribute('data-sum-mode');

        document.getElementById('sum-text-panel').style.display = (mode === 'text') ? 'block' : 'none';
        document.getElementById('sum-pdf-panel').style.display = (mode === 'pdf') ? 'block' : 'none';
        document.getElementById('sum-url-panel').style.display = (mode === 'url') ? 'block' : 'none';
        document.getElementById('sum-video-panel').style.display = (mode === 'video') ? 'block' : 'none';
    });
});

// PDF File Dropzone
const pdfDropzone = document.getElementById('pdf-dropzone');
const pdfFileInput = document.getElementById('pdf-file-input');
const pdfFilename = document.getElementById('pdf-filename');

if (pdfDropzone && pdfFileInput) {
    pdfDropzone.addEventListener('click', () => pdfFileInput.click());
    pdfDropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        pdfDropzone.style.borderColor = '#2563EB';
    });
    pdfDropzone.addEventListener('dragleave', () => {
        pdfDropzone.style.borderColor = '#BFDBFE';
    });
    pdfDropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        pdfDropzone.style.borderColor = '#BFDBFE';
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            pdfFileInput.files = e.dataTransfer.files;
            handlePdfSelect(e.dataTransfer.files[0]);
        }
    });
    pdfFileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) {
            handlePdfSelect(e.target.files[0]);
        }
    });
}

function handlePdfSelect(file) {
    if (pdfFilename) {
        pdfFilename.textContent = `📄 Selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
        pdfFilename.style.display = 'block';
    }
}

// Run Summarizer Action
const runSummarizeBtn = document.getElementById('run-summarize-btn');
if (runSummarizeBtn) {
    runSummarizeBtn.addEventListener('click', async () => {
        if (!authToken) return;
        const activeTab = document.querySelector('.sum-tab.active')?.getAttribute('data-sum-mode') || 'text';
        const format = document.getElementById('sum-format-select')?.value || 'Key Bullet Points';
        let contentToSummarize = '';

        if (activeTab === 'text') {
            contentToSummarize = document.getElementById('sum-input-text')?.value.trim();
        } else if (activeTab === 'pdf') {
            const file = pdfFileInput?.files?.[0];
            if (!file) return showToast('Please select or upload a PDF document first', 'info');
            contentToSummarize = `Document: ${file.name}\n${await extractTextFromFile(file)}`;
        } else if (activeTab === 'url') {
            const url = document.getElementById('sum-url-input')?.value.trim();
            if (!url) return showToast('Please enter a valid webpage URL', 'info');
            contentToSummarize = `URL to analyze and summarize: ${url}`;
        } else if (activeTab === 'video') {
            const video = document.getElementById('sum-video-input')?.value.trim();
            if (!video) return showToast('Please enter a YouTube video URL or lecture topic', 'info');
            contentToSummarize = `Video lecture topic/link: ${video}`;
        }

        if (!contentToSummarize) {
            return showToast('Please provide content to summarize', 'info');
        }

        const outCard = document.getElementById('sum-output-card');
        const outBody = document.getElementById('sum-output-text');
        if (outCard) outCard.style.display = 'block';
        if (outBody) outBody.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Analyzing and summarizing with AI...';

        const prompt = `Please summarize the following content in format: "${format}".\n\nContent:\n${contentToSummarize}`;

        try {
            const res = await api.generateAI(authToken, prompt, 'You are a master academic summarizer. Provide clean, well-formatted, ultra-high-yield summaries.');
            if (outBody) {
                await renderWithTyping(outBody, res.result, { renderMath: false });
            }
            const xpRes = await api.addXp(authToken, 10, 1, 'AI Summarizer');
            applyXpResult(xpRes);
            recordActivity('AI Summarizer', 'fa-solid fa-compress', 10);
            showToast('Summary completed!', 'success');
        } catch (err) {
            if (outBody) outBody.textContent = 'Failed to generate summary: ' + err.message;
        }
    });
}

// Copy & Save buttons for Summarizer
safeOn('copy-sum-btn', 'click', () => {
    const text = document.getElementById('sum-output-text')?.innerText || '';
    if (text) {
        navigator.clipboard.writeText(text);
        showToast('Summary copied to clipboard!', 'success');
    }
});

safeOn('save-sum-note-btn', 'click', async () => {
    const text = document.getElementById('sum-output-text')?.innerText || '';
    if (!text || !authToken) return;
    try {
        const title = 'AI Summary - ' + new Date().toLocaleDateString();
        await api.saveNote(authToken, title, text);
        showToast('Saved to your Notes!', 'success');
        loadNotes();
    } catch (err) {
        showToast('Failed to save note: ' + err.message, 'error');
    }
});

// 7. Focus Timer Modes & Ambient Audio Synthesizer (Web Audio API)
let audioCtx = null;
let activeSoundNode = null;
let currentPlayingSound = null;

function getAudioContext() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    return audioCtx;
}

function stopAmbientSound() {
    if (activeSoundNode) {
        try {
            if (activeSoundNode.stop) activeSoundNode.stop();
            if (activeSoundNode.disconnect) activeSoundNode.disconnect();
        } catch (e) {}
        activeSoundNode = null;
    }
    currentPlayingSound = null;
    document.querySelectorAll('.ambient-item').forEach(item => {
        item.classList.remove('playing');
        const btn = item.querySelector('.ambient-play-btn');
        if (btn) btn.innerHTML = '<i class="fa-solid fa-play"></i>';
    });
}

function playAmbientSound(soundType) {
    const ctx = getAudioContext();
    stopAmbientSound();

    if (soundType === 'whitenoise') {
        const bufferSize = ctx.sampleRate * 2;
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }
        const whiteNoise = ctx.createBufferSource();
        whiteNoise.buffer = buffer;
        whiteNoise.loop = true;

        const gainNode = ctx.createGain();
        gainNode.gain.value = 0.04;

        whiteNoise.connect(gainNode);
        gainNode.connect(ctx.destination);
        whiteNoise.start();
        activeSoundNode = whiteNoise;
    } else if (soundType === 'rain') {
        const bufferSize = ctx.sampleRate * 2;
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        let b0 = 0, b1 = 0, b2 = 0;
        for (let i = 0; i < bufferSize; i++) {
            const white = Math.random() * 2 - 1;
            b0 = 0.99886 * b0 + white * 0.0555179;
            b1 = 0.99332 * b1 + white * 0.0750759;
            b2 = 0.96900 * b2 + white * 0.1538520;
            data[i] = (b0 + b1 + b2) * 0.11;
        }
        const pinkNoise = ctx.createBufferSource();
        pinkNoise.buffer = buffer;
        pinkNoise.loop = true;

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 1000;

        const gainNode = ctx.createGain();
        gainNode.gain.value = 0.08;

        pinkNoise.connect(filter);
        filter.connect(gainNode);
        gainNode.connect(ctx.destination);
        pinkNoise.start();
        activeSoundNode = pinkNoise;
    } else if (soundType === 'binaural') {
        // 432Hz Carrier with 10Hz Alpha differential
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        osc1.type = 'sine';
        osc1.frequency.value = 432;
        osc2.type = 'sine';
        osc2.frequency.value = 442;

        const merger = ctx.createChannelMerger(2);
        const gain = ctx.createGain();
        gain.gain.value = 0.05;

        osc1.connect(merger, 0, 0);
        osc2.connect(merger, 0, 1);
        merger.connect(gain);
        gain.connect(ctx.destination);

        osc1.start();
        osc2.start();
        activeSoundNode = {
            stop: () => { osc1.stop(); osc2.stop(); },
            disconnect: () => { osc1.disconnect(); osc2.disconnect(); }
        };
    } else if (soundType === 'cafe') {
        const bufferSize = ctx.sampleRate * 2;
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.3;
        }
        const noise = ctx.createBufferSource();
        noise.buffer = buffer;
        noise.loop = true;

        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 400;
        filter.Q.value = 1.5;

        const gain = ctx.createGain();
        gain.gain.value = 0.06;

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);
        noise.start();
        activeSoundNode = noise;
    }

    currentPlayingSound = soundType;
    const activeItem = document.querySelector(`.ambient-item[data-sound="${soundType}"]`);
    if (activeItem) {
        activeItem.classList.add('playing');
        const btn = activeItem.querySelector('.ambient-play-btn');
        if (btn) btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    }
}

document.querySelectorAll('.ambient-item').forEach(item => {
    const soundType = item.getAttribute('data-sound');
    const playBtn = item.querySelector('.ambient-play-btn');
    if (playBtn) {
        playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (currentPlayingSound === soundType) {
                stopAmbientSound();
            } else {
                playAmbientSound(soundType);
            }
        });
    }
});

// Timer Mode Switcher
document.querySelectorAll('.timer-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.timer-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mins = parseInt(btn.getAttribute('data-time'), 10) || 25;
        const label = btn.getAttribute('data-label') || 'Focus Time';
        
        const labelEl = document.getElementById('timer-mode-label');
        if (labelEl) labelEl.textContent = label;

        window.timerTime = mins * 60;
        window.timerTotal = mins * 60;
        if (typeof updateTimerDisplay === 'function') updateTimerDisplay();
        if (typeof resetTimer === 'function') resetTimer();
    });
});

// 8. Note Taker Search & "AI Quiz Me" Action
const notesSearchInput = document.getElementById('notes-search');
if (notesSearchInput) {
    notesSearchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase().trim();
        document.querySelectorAll('#notes-items-container .note-item, #notes-list .note-item').forEach(item => {
            const title = item.querySelector('h4')?.textContent.toLowerCase() || '';
            const desc = item.querySelector('p')?.textContent.toLowerCase() || '';
            if (!query || title.includes(query) || desc.includes(query)) {
                item.style.display = 'block';
            } else {
                item.style.display = 'none';
            }
        });
    });
}

safeOn('quiz-note-btn', 'click', () => {
    const title = document.getElementById('note-title')?.value || 'My Study Notes';
    sections.forEach(s => s.classList.remove('active'));
    document.getElementById('worksheets').classList.add('active');
    navItems.forEach(n => n.classList.remove('active'));
    document.querySelector('.nav-item[data-target="worksheets"]')?.classList.add('active');

    const topicInput = document.getElementById('ws-topic');
    if (topicInput) {
        topicInput.value = `Comprehensive Quiz on: ${title}`;
        topicInput.focus();
    }
    showToast(`Generating quiz topic from note: "${title}"`, 'info');
});

safeOn('delete-note-btn', 'click', async () => {
    if (window.currentNoteId && authToken) {
        if (!confirm('Are you sure you want to delete this note?')) return;
        try {
            await api.deleteNote(authToken, window.currentNoteId);
            showToast('Note deleted', 'info');
            window.currentNoteId = null;
            document.getElementById('note-title').value = '';
            document.getElementById('note-content').value = '';
            loadNotes();
        } catch (err) {
            showToast('Failed to delete: ' + err.message, 'error');
        }
    } else {
        document.getElementById('note-title').value = '';
        document.getElementById('note-content').value = '';
    }
});

// ================================================================
// DEDICATED DEVELOPER HUB PORTAL CONTROLLER (RESPONSIVE & DYNAMIC)
// ================================================================
const devPortalContainer = document.getElementById('developer-portal-container');
let currentDevExamQuestions = [];
let devExamClockInterval = null;
let currentRenderedDevNotes = '';

// Persistent & Interactive Developer Skills Store
function getDeveloperSkills() {
    try {
        const stored = localStorage.getItem('devUserSkills');
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        }
    } catch(e) {}
    
    // Default initial skills
    return [
        { name: 'JavaScript', level: 'Advanced' },
        { name: 'React', level: 'Advanced' },
        { name: 'Node.js', level: 'Intermediate' },
        { name: 'Python', level: 'Intermediate' },
        { name: 'SQL', level: 'Intermediate' }
    ];
}

function saveDeveloperSkills(skills) {
    localStorage.setItem('devUserSkills', JSON.stringify(skills));
    renderDevSkills();
}

function renderDevSkills() {
    const skills = getDeveloperSkills();
    const container = document.getElementById('devhub-skills-tiles-container');
    const addBtn = document.getElementById('devhub-btn-add-skill');
    
    if (container) {
        // Remove existing skill boxes (keep addBtn)
        const existingTiles = container.querySelectorAll('.devhub-skill-box-jsx');
        existingTiles.forEach(t => t.remove());

        skills.forEach((skill, idx) => {
            const box = document.createElement('div');
            box.className = 'devhub-skill-box-jsx';
            box.innerHTML = `
                <div class="devhub-skill-top-row">
                    <p class="devhub-skill-name-jsx">${escapeHtml(skill.name)}</p>
                    <button class="devhub-skill-delete-btn" data-index="${idx}" title="Remove ${escapeHtml(skill.name)}">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <p class="devhub-skill-lvl-jsx">${escapeHtml(skill.level || 'Intermediate')}</p>
            `;
            if (addBtn) {
                container.insertBefore(box, addBtn);
            } else {
                container.appendChild(box);
            }
        });

        // Add delete event listeners
        container.querySelectorAll('.devhub-skill-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const index = parseInt(btn.getAttribute('data-index'), 10);
                const current = getDeveloperSkills();
                if (!isNaN(index) && current[index]) {
                    const removed = current.splice(index, 1);
                    saveDeveloperSkills(current);
                    showToast(`Removed ${removed[0].name} from skills`, 'info');
                }
            });
        });
    }

    // Update Skills Count Stat Card
    const countEl = document.getElementById('devhub-stat-skills');
    if (countEl) {
        countEl.textContent = skills.length;
    }

    // Feed skills into Mock Test Subject Dropdown
    const testSubjectSelect = document.getElementById('devhub-test-subject');
    if (testSubjectSelect) {
        const currentVal = testSubjectSelect.value;
        testSubjectSelect.innerHTML = '';
        skills.forEach(skill => {
            const opt = document.createElement('option');
            opt.value = skill.name;
            opt.textContent = `${skill.name} (${skill.level})`;
            testSubjectSelect.appendChild(opt);
        });
        // Add additional option for custom stack
        const customOpt = document.createElement('option');
        customOpt.value = 'Fullstack & System Architecture';
        customOpt.textContent = '🌐 Fullstack & System Architecture';
        testSubjectSelect.appendChild(customOpt);

        if (currentVal && skills.some(s => s.name === currentVal)) {
            testSubjectSelect.value = currentVal;
        }
    }
}

// Letter Avatar Generation (Never Use Human Face Photos)
function updateDeveloperAvatar(name) {
    const cleanName = (name || 'Arjun').trim();
    const firstLetter = cleanName.charAt(0).toUpperCase() || 'A';
    const avatarEl = document.getElementById('devhub-avatar-initial');
    if (avatarEl) {
        avatarEl.textContent = firstLetter;
    }
}

function showDeveloperPortal(defaultTab = 'dashboard') {
    localStorage.setItem('activePortalMode', 'developer');
    if (authModal) authModal.style.display = 'none';
    if (window.hideLanding) window.hideLanding();
    if (appContainer) appContainer.style.display = 'none';

    if (devPortalContainer) {
        devPortalContainer.style.display = 'flex';
        devPortalContainer.style.opacity = '0';
        requestAnimationFrame(() => {
            devPortalContainer.style.transition = 'opacity 0.4s ease';
            devPortalContainer.style.opacity = '1';
        });
    }

    // Populate user profile info in Developer Hub with pure letter avatar
    const username = currentUserData?.username || 'Arjun Dev';
    const cleanName = username.split('@')[0] || 'Arjun';
    const capitalizedName = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);

    const devNameEl = document.getElementById('devhub-user-name');
    const greetingEl = document.getElementById('devhub-greeting-name');
    const heroNameEl = document.getElementById('devhub-hero-name');
    const devLvlEl = document.getElementById('devhub-user-lvl');

    if (devNameEl) devNameEl.textContent = `${capitalizedName} Dev`;
    if (greetingEl) greetingEl.textContent = capitalizedName;
    if (heroNameEl) heroNameEl.textContent = capitalizedName;
    if (devLvlEl) devLvlEl.textContent = `Level ${currentUserData?.level || 4}`;

    updateDeveloperAvatar(capitalizedName);
    renderDevSkills();

    // Switch to target or saved tab
    const tabToOpen = defaultTab || localStorage.getItem('activeDevTab') || 'dashboard';
    switchDevTab(tabToOpen);
}

function showStudentPortal() {
    localStorage.setItem('activePortalMode', 'student');
    if (devPortalContainer) devPortalContainer.style.display = 'none';
    if (window.hideLanding) window.hideLanding();
    showAppContainer();
    // Default to dashboard
    document.querySelectorAll('.section-container').forEach(s => s.classList.remove('active'));
    document.getElementById('dashboard')?.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector('.nav-item[data-target="dashboard"]')?.classList.add('active');
}

// Student Hub sidebar "Developer Hub" item click
document.querySelector('.nav-item[data-target="developer-hub"]')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showDeveloperPortal('dashboard');
});

// Developer Hub sidebar "Switch to Student Hub" click
document.getElementById('devhub-switch-student-btn')?.addEventListener('click', () => {
    showStudentPortal();
});

// Mobile Drawer Toggle
const devMobileBtn = document.getElementById('devhub-mobile-toggle-btn');
const devSidebarEl = document.getElementById('devhub-sidebar');
const devBackdropEl = document.getElementById('devhub-sidebar-backdrop');

function toggleDevMobileSidebar(open) {
    if (devSidebarEl && devBackdropEl) {
        if (open === undefined) {
            devSidebarEl.classList.toggle('open');
            devBackdropEl.classList.toggle('active');
        } else if (open) {
            devSidebarEl.classList.add('open');
            devBackdropEl.classList.add('active');
        } else {
            devSidebarEl.classList.remove('open');
            devBackdropEl.classList.remove('active');
        }
    }
}

devMobileBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDevMobileSidebar();
});

devBackdropEl?.addEventListener('click', () => {
    toggleDevMobileSidebar(false);
});

// Tab Switcher inside Developer Hub
function switchDevTab(tabId, updateUrl = true) {
    localStorage.setItem('activeDevTab', tabId);
    if (updateUrl) {
        syncUrl(tabId === 'dashboard' ? '/developer' : `/developer/${tabId}`);
    }
    toggleDevMobileSidebar(false); // Close mobile drawer when clicking a tab

    // Update nav item active states
    document.querySelectorAll('.devhub-nav-item').forEach(item => {
        if (item.getAttribute('data-dev-tab') === tabId) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });

    // Hide all panes
    document.querySelectorAll('.devhub-tab-pane').forEach(pane => pane.style.display = 'none');

    // Show target pane
    if (tabId === 'dashboard') {
        document.getElementById('devhub-tab-dashboard').style.display = 'flex';
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (tabId === 'tests') {
        document.getElementById('devhub-tab-tests').style.display = 'block';
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (tabId === 'notes') {
        document.getElementById('devhub-tab-notes').style.display = 'block';
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (tabId === 'review') {
        document.getElementById('devhub-tab-review').style.display = 'block';
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (tabId === 'skills') {
        document.getElementById('devhub-tab-dashboard').style.display = 'flex';
        document.getElementById('devhub-skills-tiles-container')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (tabId === 'projects') {
        document.getElementById('devhub-tab-dashboard').style.display = 'flex';
        document.querySelector('.devhub-proj-grid-jsx')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
        // Achievements / Bookmarks / Community / Settings
        document.getElementById('devhub-tab-dashboard').style.display = 'flex';
        showToast(`Navigated to ${tabId.charAt(0).toUpperCase() + tabId.slice(1)} Studio`, 'info');
    }
}

document.querySelectorAll('.devhub-nav-item').forEach(item => {
    item.addEventListener('click', () => {
        const tab = item.getAttribute('data-dev-tab');
        if (tab) switchDevTab(tab);
    });
});

// Continue Learning Buttons
document.getElementById('devhub-btn-start-test')?.addEventListener('click', () => switchDevTab('tests'));
document.getElementById('devhub-btn-explore-notes')?.addEventListener('click', () => switchDevTab('notes'));
document.getElementById('devhub-btn-upload-project')?.addEventListener('click', () => switchDevTab('review'));
document.getElementById('devhub-card-upload-project')?.addEventListener('click', () => switchDevTab('review'));
document.getElementById('devhub-btn-review-code')?.addEventListener('click', () => switchDevTab('review'));

// Feed Action Buttons
document.getElementById('devhub-feed-btn-1')?.addEventListener('click', () => switchDevTab('tests'));
document.getElementById('devhub-feed-btn-2')?.addEventListener('click', () => switchDevTab('notes'));
document.getElementById('devhub-feed-btn-3')?.addEventListener('click', () => switchDevTab('review'));

// View All Links
document.getElementById('devhub-link-all-learning')?.addEventListener('click', (e) => { e.preventDefault(); switchDevTab('tests'); });
document.getElementById('devhub-link-all-projects')?.addEventListener('click', (e) => { e.preventDefault(); switchDevTab('review'); });

// Add Skill Modal & Quick Chips
const addSkillModal = document.getElementById('devhub-add-skill-modal');
document.getElementById('devhub-btn-add-skill')?.addEventListener('click', () => {
    if (addSkillModal) addSkillModal.style.display = 'flex';
    document.getElementById('devhub-new-skill-name')?.focus();
});
document.getElementById('devhub-close-skill-modal-btn')?.addEventListener('click', () => {
    if (addSkillModal) addSkillModal.style.display = 'none';
});

// Quick Chip Clicks
document.querySelectorAll('.devhub-chip-btn').forEach(chip => {
    chip.addEventListener('click', () => {
        const skill = chip.getAttribute('data-skill');
        const input = document.getElementById('devhub-new-skill-name');
        if (input && skill) {
            input.value = skill;
            document.querySelectorAll('.devhub-chip-btn').forEach(c => c.classList.remove('selected'));
            chip.classList.add('selected');
        }
    });
});

document.getElementById('devhub-save-new-skill-btn')?.addEventListener('click', () => {
    const skillName = document.getElementById('devhub-new-skill-name')?.value?.trim();
    const skillLevel = document.getElementById('devhub-new-skill-level')?.value || 'Intermediate';
    if (!skillName) return alert('Please enter or select a skill/framework.');

    const current = getDeveloperSkills();
    // Avoid duplicate names
    const existingIdx = current.findIndex(s => s.name.toLowerCase() === skillName.toLowerCase());
    if (existingIdx >= 0) {
        current[existingIdx].level = skillLevel;
        showToast(`Updated ${skillName} level to ${skillLevel}! ✨`, 'info');
    } else {
        current.push({ name: skillName, level: skillLevel });
        showToast(`Fed & added ${skillName} (${skillLevel}) to your profile! ✨`, 'success');
    }

    saveDeveloperSkills(current);
    document.getElementById('devhub-new-skill-name').value = '';
    document.querySelectorAll('.devhub-chip-btn').forEach(c => c.classList.remove('selected'));
    if (addSkillModal) addSkillModal.style.display = 'none';
});


// ================================================================
// MOCK TEST RUNNER ENGINE
// ================================================================
function updateDevExamProgress() {
    if (!currentDevExamQuestions || currentDevExamQuestions.length === 0) return;
    const total = currentDevExamQuestions.length;
    let answeredCount = 0;

    currentDevExamQuestions.forEach((q, idx) => {
        const qId = q.id || (idx + 1);
        const radio = document.querySelector(`input[name="devhub_exam_q_${qId}"]:checked`);
        const pill = document.getElementById(`devhub-exam-nav-pill-${idx + 1}`);

        if (radio) {
            answeredCount++;
            if (pill) {
                pill.style.background = '#2563EB';
                pill.style.color = '#FFFFFF';
                pill.style.borderColor = '#2563EB';
            }
        } else {
            if (pill) {
                pill.style.background = '#FFFFFF';
                pill.style.color = '#1E293B';
                pill.style.borderColor = '#E2E8F0';
            }
        }
    });

    const pct = Math.round((answeredCount / total) * 100);
    const label = document.getElementById('devhub-exam-progress-text');
    const fill = document.getElementById('devhub-exam-progress-fill');
    if (label) label.textContent = `Answered: ${answeredCount} / ${total} (${pct}%)`;
    if (fill) fill.style.width = `${pct}%`;
}

function startDevExamTimer(seconds = 900) {
    if (devExamClockInterval) clearInterval(devExamClockInterval);
    const clockEl = document.getElementById('devhub-exam-time-clock');
    if (!clockEl) return;

    let timeLeft = seconds;
    function tick() {
        const mins = Math.floor(timeLeft / 60);
        const secs = timeLeft % 60;
        clockEl.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    tick();

    devExamClockInterval = setInterval(() => {
        timeLeft--;
        if (timeLeft <= 0) {
            clearInterval(devExamClockInterval);
            tick();
            alert('⏱️ Exam time has elapsed! Auto-submitting answers for AI evaluation...');
            document.getElementById('devhub-submit-exam-btn')?.click();
        } else {
            tick();
        }
    }, 1000);
}

document.getElementById('devhub-run-test-now-btn')?.addEventListener('click', async () => {
    const skill = document.getElementById('devhub-test-skill-select')?.value;
    const level = document.getElementById('devhub-test-level-select')?.value;
    const count = parseInt(document.getElementById('devhub-test-q-count')?.value, 10) || 5;
    const loading = document.getElementById('devhub-test-loading-msg');

    if (loading) loading.style.display = 'block';
    document.getElementById('devhub-live-exam-area').style.display = 'none';
    document.getElementById('devhub-exam-results-area').style.display = 'none';

    const prompt = `You are a Principal Software Engineer and FAANG Technical Interviewer.
Create a real-world, high quality, multiple-choice technical coding assessment for "${skill}" at the ${level} seniority level.
Generate exactly ${count} questions. Include realistic code snippets, output predictions, bug diagnoses, and architectural edge cases.

Return ONLY a valid JSON array of objects with NO surrounding markdown backticks or commentary:
[
  {
    "id": 1,
    "question": "Question text or scenario",
    "code_snippet": "optional realistic code or empty string",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct_answer": "Exact text of the correct option",
    "explanation": "Deep technical analysis explaining why this is correct and why other options are bugs or suboptimal."
  }
]`;

    try {
        const res = await api.generateAI(authToken, prompt, "You are a senior tech lead formatting strictly as JSON.");
        const questions = extractJsonPayload(res.result, true);
        currentDevExamQuestions = questions;

        document.getElementById('devhub-exam-paper-title').textContent = `${skill} • ${level}`;
        const qContainer = document.getElementById('devhub-exam-questions-list');
        const pillsContainer = document.getElementById('devhub-exam-pills-row');
        qContainer.innerHTML = '';
        pillsContainer.innerHTML = '';

        questions.forEach((q, idx) => {
            const qNum = idx + 1;
            const qId = q.id || qNum;
            const card = document.createElement('div');
            card.className = 'ws-question-card glass';
            card.id = `devhub-q-card-${qNum}`;

            let html = `
                <div class="ws-q-header">
                    <span class="ws-q-number" style="background: linear-gradient(135deg,#2563EB,#1D4ED8);">Q${qNum}</span>
                    <h4 class="ws-q-text">${escapeHtml(q.question)}</h4>
                </div>
            `;

            if (q.code_snippet && q.code_snippet.trim().length > 0) {
                html += `<pre class="ws-code-block"><code>${escapeHtml(q.code_snippet.trim())}</code></pre>`;
            }

            const opts = Array.isArray(q.options) ? q.options : ['Option A', 'Option B', 'Option C', 'Option D'];
            html += `<div class="ws-options-grid">`;
            opts.forEach((opt, optIdx) => {
                const letter = String.fromCharCode(65 + optIdx);
                const cleanOpt = String(opt).replace(/^[A-Da-d][\.\)]\s*/, '').trim() || String(opt);
                const optId = `devhub_opt_${qId}_${optIdx}`;

                html += `
                    <label class="ws-option-pill" for="${optId}">
                        <input type="radio" id="${optId}" name="devhub_exam_q_${qId}" value="${escapeHtml(cleanOpt)}" class="ws-radio-input">
                        <span class="ws-opt-badge">${letter}.</span>
                        <span class="ws-opt-text">${escapeHtml(cleanOpt)}</span>
                    </label>
                `;
            });
            html += `</div>`;

            card.innerHTML = html;

            // Highlight selected pill with white text
            card.querySelectorAll('.ws-radio-input').forEach(radio => {
                radio.addEventListener('change', () => {
                    card.querySelectorAll('.ws-option-pill').forEach(p => p.classList.remove('active-selected'));
                    if (radio.checked) {
                        radio.closest('.ws-option-pill')?.classList.add('active-selected');
                    }
                    updateDevExamProgress();
                });
            });

            qContainer.appendChild(card);

            // Nav pill
            const pill = document.createElement('button');
            pill.className = 'ws-q-nav-pill';
            pill.id = `devhub-exam-nav-pill-${qNum}`;
            pill.textContent = qNum;
            pill.addEventListener('click', () => {
                document.getElementById(`devhub-q-card-${qNum}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
            pillsContainer.appendChild(pill);
        });

        updateDevExamProgress();
        startDevExamTimer(900); // 15 mins

        document.getElementById('devhub-live-exam-area').style.display = 'block';
        if (loading) loading.style.display = 'none';
        document.getElementById('devhub-live-exam-area').scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
        console.error(err);
        if (loading) loading.textContent = 'Error generating test questions. Please retry.';
    }
});

// Submit Exam for AI Grading
document.getElementById('devhub-submit-exam-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('devhub-submit-exam-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Grading with AI...';
    if (devExamClockInterval) clearInterval(devExamClockInterval);

    let studentAnswers = [];
    currentDevExamQuestions.forEach((q, idx) => {
        const qId = q.id || (idx + 1);
        const radio = document.querySelector(`input[name="devhub_exam_q_${qId}"]:checked`);
        studentAnswers.push({
            id: qId,
            question: q.question,
            code_snippet: q.code_snippet || '',
            student_answer: radio ? radio.value.trim() : '',
            correct_answer: q.correct_answer || '',
            explanation: q.explanation || ''
        });
    });

    const prompt = `Grade the technical assessment below.
Return strictly a valid JSON object with score and detailed feedback array:
{
  "score": "X/Y (Z%)",
  "feedback": [
     {
        "id": 1,
        "question": "Question text",
        "student_answer": "Student choice",
        "correct": true,
        "correct_answer": "Correct choice",
        "explanation": "Detailed technical analysis"
     }
  ]
}

Answers:
${JSON.stringify(studentAnswers, null, 2)}`;

    try {
        const res = await api.generateAI(authToken, prompt, "You are a technical evaluation engine. Output strictly JSON.");
        const grading = extractJsonPayload(res.result, false);

        document.getElementById('devhub-final-score-text').textContent = grading.score || '85%';
        const fbContainer = document.getElementById('devhub-exam-feedback-list');
        fbContainer.innerHTML = '';

        if (Array.isArray(grading.feedback)) {
            grading.feedback.forEach((f, idx) => {
                const isCorrect = Boolean(f.correct);
                const originalQ = studentAnswers[idx] || {};
                const studentAns = f.student_answer || originalQ.student_answer || '(No answer provided)';
                const correctAns = f.correct_answer || originalQ.correct_answer || '';
                const questionText = f.question || originalQ.question || `Question ${idx + 1}`;

                const card = document.createElement('div');
                card.className = `ws-feedback-card glass ${isCorrect ? 'ws-fb-correct' : 'ws-fb-incorrect'}`;

                card.innerHTML = `
                    <div class="ws-fb-top">
                        <div class="ws-fb-q-info">
                            <span class="ws-fb-q-num" style="background: linear-gradient(135deg,#2563EB,#1D4ED8);">Q${idx + 1}</span>
                            <span class="ws-fb-q-title">${escapeHtml(questionText)}</span>
                        </div>
                        <span class="ws-fb-status-pill ${isCorrect ? 'status-correct' : 'status-incorrect'}">
                            ${isCorrect ? '<i class="fa-solid fa-circle-check"></i> Correct' : '<i class="fa-solid fa-circle-xmark"></i> Incorrect'}
                        </span>
                    </div>
                    <div class="ws-fb-answers">
                        <div class="ws-fb-ans-row">
                            <span class="ws-fb-ans-label"><i class="fa-solid fa-terminal"></i> Your Answer:</span>
                            <span class="ws-fb-ans-val ${isCorrect ? 'ans-correct' : 'ans-wrong'}">${escapeHtml(studentAns)}</span>
                        </div>
                        ${!isCorrect && correctAns ? `
                        <div class="ws-fb-ans-row">
                            <span class="ws-fb-ans-label"><i class="fa-solid fa-circle-check"></i> Correct Answer:</span>
                            <span class="ws-fb-ans-val ans-correct">${escapeHtml(correctAns)}</span>
                        </div>` : ''}
                    </div>
                    <div class="ws-fb-explanation">
                        <i class="fa-solid fa-lightbulb"></i>
                        <div>
                            <strong>Technical Analysis: </strong>
                            <span>${escapeHtml(f.explanation || originalQ.explanation)}</span>
                        </div>
                    </div>
                `;

                fbContainer.appendChild(card);
            });
        }

        // Increment tests taken stat in dashboard
        const testCountEl = document.getElementById('devhub-stat-tests');
        if (testCountEl) {
            const c = parseInt(testCountEl.textContent, 10) || 24;
            testCountEl.textContent = c + 1;
        }

        document.getElementById('devhub-exam-results-area').style.display = 'block';
        document.getElementById('devhub-exam-results-area').scrollIntoView({ behavior: 'smooth' });

        api.addXp(authToken, 80, 15, 'Completed Technical Mock Test').then(r => applyXpResult(r));
    } catch (err) {
        console.error(err);
        alert('Failed to evaluate assessment. Please retry.');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-check-double"></i> Submit Test for AI Grading';
    }
});

document.getElementById('devhub-retake-exam-btn')?.addEventListener('click', () => {
    document.getElementById('devhub-exam-results-area').style.display = 'none';
    document.getElementById('devhub-live-exam-area').style.display = 'block';
    document.querySelectorAll('.ws-radio-input').forEach(r => r.checked = false);
    document.querySelectorAll('.ws-option-pill').forEach(p => p.classList.remove('active-selected'));
    updateDevExamProgress();
    startDevExamTimer(900);
    document.getElementById('devhub-live-exam-area').scrollIntoView({ behavior: 'smooth' });
});

// ================================================================
// AI TECHNICAL NOTES ENGINE
// ================================================================
document.getElementById('devhub-gen-notes-btn')?.addEventListener('click', async () => {
    const topic = document.getElementById('devhub-notes-topic-input')?.value?.trim();
    const level = document.getElementById('devhub-notes-level-select')?.value;
    const loading = document.getElementById('devhub-notes-loading-msg');

    if (!topic) return alert('Please enter a technical topic or concept.');
    if (loading) loading.style.display = 'block';
    document.getElementById('devhub-notes-render-area').style.display = 'none';

    const prompt = `You are a Principal Software Engineer and System Architect.
Write an authoritative, clean, comprehensive technical study guide on:
Topic: "${topic}"
Depth: "${level}"

Structure your guide in clean Markdown with:
1. 🏛️ Core Architecture & Design Fundamentals
2. 💻 Real-world Code Implementation Patterns & Best Practices
3. ⚡ Top 10 High-Frequency Technical Interview Questions with In-depth Answers
4. ⚠️ Critical Performance Bottlenecks, Memory/Concurrency Pitfalls & Anti-Patterns`;

    try {
        const res = await api.generateAI(authToken, prompt, "You are an elite technical educator writing clean markdown.");
        currentRenderedDevNotes = res.result || '';

        document.getElementById('devhub-rendered-notes-title').textContent = `${topic} • ${level}`;
        const bodyEl = document.getElementById('devhub-rendered-notes-body');
        if (typeof marked !== 'undefined') {
            bodyEl.innerHTML = marked.parse(currentRenderedDevNotes);
        } else {
            bodyEl.textContent = currentRenderedDevNotes;
        }

        document.getElementById('devhub-notes-render-area').style.display = 'block';
        if (loading) loading.style.display = 'none';
        document.getElementById('devhub-notes-render-area').scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
        console.error(err);
        if (loading) loading.textContent = 'Error writing notes. Please retry.';
    }
});

document.getElementById('devhub-save-notes-to-book-btn')?.addEventListener('click', async () => {
    const topic = document.getElementById('devhub-notes-topic-input')?.value || 'Technical Architecture Notes';
    if (!currentRenderedDevNotes) return showToast('No notes to save', 'error');

    if (authToken) {
        try {
            await api.createNote(authToken, topic, currentRenderedDevNotes);
            showToast(`Saved "${topic}" to your Notebook! 📝`, 'success');
            loadNotes();
        } catch (err) {
            showToast('Failed to save note: ' + err.message, 'error');
        }
    } else {
        showToast('Please sign in to save notes', 'error');
    }
});

// ================================================================
// AI CODE REVIEW STUDIO
// ================================================================
document.getElementById('devhub-run-review-btn')?.addEventListener('click', async () => {
    const title = document.getElementById('devhub-review-title-input')?.value?.trim();
    const lang = document.getElementById('devhub-review-lang-select')?.value;
    const code = document.getElementById('devhub-review-code-input')?.value?.trim();
    const loading = document.getElementById('devhub-review-loading-msg');

    if (!code) return alert('Please paste your source code to review.');
    if (loading) loading.style.display = 'block';
    document.getElementById('devhub-review-render-area').style.display = 'none';

    const prompt = `You are a Principal Security Engineer and Tech Lead.
Perform an exhaustive code review of the following ${lang} code:
Project Title: "${title}"
Source Code:
\`\`\`${lang}
${code}
\`\`\`

Provide a comprehensive code review report formatted in Markdown:
1. 📊 AI Code Rating Score: Compute an overall quality score out of 100 with rationale.
2. 🔒 Security & Vulnerability Analysis (SQL injection, XSS, memory leaks, auth flaws)
3. ⚡ Time & Space Complexity Analysis
4. 🧹 Clean Code, Design Patterns & Performance Improvements
5. 🚀 Refactored Production Code Example`;

    try {
        const res = await api.generateAI(authToken, prompt, "You are a senior code reviewer formatting in markdown.");
        const text = res.result || '';

        // Extract score if present
        const match = text.match(/Score[:\s]+(\d+)\s*\/\s*100/i) || text.match(/(\d+)\s*\/\s*100/);
        const scoreVal = match ? match[1] : '88';
        document.getElementById('devhub-reviewed-score-val').textContent = `${scoreVal}/100`;

        const bodyEl = document.getElementById('devhub-reviewed-feedback-body');
        if (typeof marked !== 'undefined') {
            bodyEl.innerHTML = marked.parse(text);
        } else {
            bodyEl.textContent = text;
        }

        // Increment projects count in dashboard
        const projCountEl = document.getElementById('devhub-stat-projects');
        if (projCountEl) {
            const p = parseInt(projCountEl.textContent, 10) || 8;
            projCountEl.textContent = p + 1;
        }

        document.getElementById('devhub-review-render-area').style.display = 'block';
        if (loading) loading.style.display = 'none';
        document.getElementById('devhub-review-render-area').scrollIntoView({ behavior: 'smooth' });

        api.addXp(authToken, 60, 10, 'Ran AI Code Review').then(r => applyXpResult(r));
    } catch (err) {
        console.error(err);
        if (loading) loading.textContent = 'Error reviewing code. Please retry.';
    }
});

// ================================================================
// STUDYHUB SIDEBAR COLLAPSE / EXPAND CONTROLLER (ICON RAIL WITH VISIBLE LOGO)
// ================================================================
function setSidebarCollapsed(collapsed) {
    const sb = document.getElementById('studyhub-sidebar');
    const wrap = document.getElementById('app-container');
    const icon = document.getElementById('sidebar-collapse-icon');
    if (!sb || !wrap) return;

    if (collapsed) {
        sb.classList.add('collapsed');
        wrap.classList.add('sidebar-collapsed');
        if (icon) icon.className = 'fa-solid fa-chevron-right';
        localStorage.setItem('studySidebarCollapsed', 'true');
    } else {
        sb.classList.remove('collapsed');
        wrap.classList.remove('sidebar-collapsed');
        if (icon) icon.className = 'fa-solid fa-chevron-left';
        localStorage.setItem('studySidebarCollapsed', 'false');
    }
}

document.getElementById('sidebar-collapse-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const sb = document.getElementById('studyhub-sidebar');
    const isCurrentlyCollapsed = sb?.classList.contains('collapsed');
    setSidebarCollapsed(!isCurrentlyCollapsed);
});

// Clicking the logo icon when collapsed expands it
document.querySelector('#studyhub-sidebar .logo-icon-wrap')?.addEventListener('click', () => {
    const sb = document.getElementById('studyhub-sidebar');
    if (sb?.classList.contains('collapsed')) {
        setSidebarCollapsed(false);
    }
});

// Restore saved collapse state on startup
if (localStorage.getItem('studySidebarCollapsed') === 'true') {
    setSidebarCollapsed(true);
}

// Floating AI Companion Trigger
document.getElementById('ai-companion-floating-trigger')?.addEventListener('click', () => {
    // Switch to AI Companion tab
    const chatNavItem = document.querySelector('.nav-item[data-target="ai-chat"]');
    if (chatNavItem) {
        chatNavItem.click();
    } else {
        document.querySelectorAll('.section-container').forEach(s => s.classList.remove('active'));
        document.getElementById('ai-chat')?.classList.add('active');
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    }
    document.getElementById('grok-chat-input')?.focus();
});

// ================================================================
// GROK-INSPIRED OMNIPOTENT AI STUDY COMPANION & TOOL ENGINE
// ================================================================
let grokChatHistory = [];
// The conversation the tutor is currently remembering. Created lazily on
// the first message and restored on load, so context survives a refresh.
let activeChatThreadId = (() => {
    try { return Number(localStorage.getItem('activeChatThreadId')) || null; }
    catch (e) { return null; }
})();

async function ensureChatThread() {
    if (activeChatThreadId) return activeChatThreadId;
    try {
        const r = await api.createChatThread(authToken, 'New chat');
        if (r && r.success) {
            activeChatThreadId = r.thread.id;
            try { localStorage.setItem('activeChatThreadId', String(activeChatThreadId)); } catch (e) {}
        }
    } catch (e) {
        console.warn('[CHAT] could not start a thread:', e.message);
    }
    return activeChatThreadId;
}
let grokActiveToolMode = 'all';

const grokChatInput = document.getElementById('grok-chat-input');
const grokChatStream = document.getElementById('grok-chat-stream');
const grokWelcomeView = document.getElementById('grok-welcome-view');
const grokSendBtn = document.getElementById('grok-send-btn');
const grokSlashPopup = document.getElementById('grok-slash-popup');

// Update welcome username on launch
function syncGrokWelcomeName() {
    const displayName = getCleanStudentName();
    const nameEl = document.getElementById('grok-user-welcome-name');
    if (nameEl) nameEl.textContent = displayName;
}
syncGrokWelcomeName();

// Auto-expand textarea
grokChatInput?.addEventListener('input', () => {
    grokChatInput.style.height = 'auto';
    grokChatInput.style.height = Math.min(grokChatInput.scrollHeight, 140) + 'px';

    const val = grokChatInput.value;
    if (val.startsWith('/') && grokSlashPopup) {
        grokSlashPopup.style.display = 'flex';
    } else if (grokSlashPopup) {
        grokSlashPopup.style.display = 'none';
    }
});

// Slash Command item click — the popup items and the welcome-screen rail
// chips both just prefill the composer with the command.
document.querySelectorAll('.grok-slash-item, .grok-rail-chip').forEach(item => {
    item.addEventListener('click', () => {
        const cmd = item.getAttribute('data-command');
        if (grokChatInput && cmd) {
            grokChatInput.value = cmd;
            grokChatInput.focus();
            grokChatInput.setSelectionRange(cmd.length, cmd.length);
            if (grokSlashPopup) grokSlashPopup.style.display = 'none';
        }
    });
});

// Quick Action Card click
document.querySelectorAll('.grok-card').forEach(card => {
    card.addEventListener('click', () => {
        const prompt = card.getAttribute('data-prompt');
        if (prompt && grokChatInput) {
            grokChatInput.value = prompt;
            sendGrokMessage();
        }
    });
});

// Capability chip click
document.querySelectorAll('.grok-chip-btn').forEach(chip => {
    chip.addEventListener('click', () => {
        document.querySelectorAll('.grok-chip-btn').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        grokActiveToolMode = chip.getAttribute('data-mode') || 'all';
    });
});

// Voice input lives in one place — setupVoiceInput() further down. Two
// recognisers were bound to this button before, and they fought each other:
// one started while the other's "end" event switched the button back off.

// ── Study tools inside the chat ─────────────────────────────────────
// The card owns its own behaviour; the app hands it the things only the
// app has: the API, the token, toasts, and where a follow-up card goes.
if (window.ChatToolsUI) {
    window.ChatToolsUI.configure({
        api,
        authToken: () => authToken,
        showToast,
        onSaveNote: async (title, content) => {
            try {
                await api.saveNote(authToken, title, content);
                showToast('Saved to your Notes!', 'success');
                if (typeof loadNotes === 'function') loadNotes();
            } catch (err) {
                showToast('Failed to save note', 'error');
            }
        },
        // "More questions" / "Harder" answer in the conversation, so the new
        // card lands in the stream like any other reply.
        onFollowUp: (res) => {
            if (!res || !res.tool || !grokChatStream) return;
            const row = document.createElement('div');
            row.className = 'grok-msg-row grok-msg-ai';
            row.innerHTML = `<div class="grok-ai-bubble">
                <div class="grok-response-body">${escapeHtml(res.result || '')}</div>
                ${window.ChatToolsUI.render(res)}
            </div>`;
            grokChatStream.appendChild(row);
            window.ChatToolsUI.wire(row);
            row.scrollIntoView({ block: 'nearest' });
        }
    });
}

// Attach Document simulation
document.getElementById('grok-attach-btn')?.addEventListener('click', () => {
    const filePrompt = prompt('Paste URL, notes, or textbook chapter snippet to analyze with AI:');
    if (filePrompt && grokChatInput) {
        grokChatInput.value = `[Document Context attached]:\n"${filePrompt.substring(0, 300)}..."\n\nPlease explain and quiz me on this document.`;
        grokChatInput.focus();
    }
});

// Keeps the stream's layout mode in sync with the welcome view: the empty
// state is centred in the available height, a real conversation is not.
function setGrokWelcomeVisible(visible) {
    if (grokWelcomeView) grokWelcomeView.style.display = visible ? 'flex' : 'none';
    if (grokChatStream) grokChatStream.classList.toggle('is-welcome', visible);
}

// New Chat button
document.getElementById('grok-new-chat-btn')?.addEventListener('click', () => {
    grokChatHistory = [];
    activeChatThreadId = null;
    try { localStorage.removeItem('activeChatThreadId'); } catch (e) {}
    if (grokChatStream) {
        grokChatStream.innerHTML = '';
        if (grokWelcomeView) {
            grokChatStream.appendChild(grokWelcomeView);
            setGrokWelcomeVisible(true);
            syncGrokWelcomeName();
        }
    }
    if (grokChatInput) grokChatInput.value = '';
    showToast('Started new AI study session ✨', 'info');
});

// Clear Chat button
document.getElementById('grok-clear-chat-btn')?.addEventListener('click', () => {
    if (confirm('Clear all conversation messages?')) {
        grokChatHistory = [];
        if (grokChatStream) {
            grokChatStream.innerHTML = '';
            if (grokWelcomeView) {
                grokChatStream.appendChild(grokWelcomeView);
                setGrokWelcomeVisible(true);
                syncGrokWelcomeName();
            }
        }
    }
});

// Send Message Handler with Adaptive Thinking & Tool Routing
async function sendGrokMessage() {
    const text = grokChatInput?.value?.trim();
    if (!text) return;

    // Every exchange belongs to a thread — that's what gives the tutor memory.
    await ensureChatThread();

    setGrokWelcomeVisible(false);
    if (grokSlashPopup) grokSlashPopup.style.display = 'none';

    // 1. Render User Message
    const userRow = document.createElement('div');
    userRow.className = 'grok-msg-row grok-msg-user';
    userRow.innerHTML = `<div class="grok-user-bubble">${escapeHtml(text)}</div>`;
    grokChatStream.appendChild(userRow);

    grokChatInput.value = '';
    grokChatInput.style.height = 'auto';
    grokChatStream.scrollTop = grokChatStream.scrollHeight;

    // 2. Classify the query for tool routing
    const cleanLower = text.toLowerCase().trim();
    const domainMatch = text.match(/([a-zA-Z0-9-]+\.(?:org|live|com|net|in|io|edu|gov|co|app|tech))/i);
    const isDomainLookup = Boolean(domainMatch);
    const targetDomain = domainMatch ? domainMatch[1] : '';
    const isSearchCmd = cleanLower.startsWith('search') || cleanLower.startsWith('lookup') || cleanLower.startsWith('find') || cleanLower.includes('search for') || isDomainLookup;
    const isStemQuery = /(roots\s+of|derivative|integral|\b\d+[xX]\^|solve\s+|equation|calculate|prove\b)/i.test(cleanLower);

    const cleanTopic = targetDomain || (isSearchCmd ? text.replace(/^(search\s+for|search|lookup|find)\s+/i, '') : text.substring(0, 45));

    // 3. Render the live working panel.
    // Every step shown here is one the server actually recorded for this
    // request ("Checked your memory", "Searched Kaveri — found 3 passages"),
    // polled while the answer is being written. It replaces a scripted tree
    // ("Ran 4 searches", "Opened page…") revealed on a one-second timer,
    // which described work the app never did.
    const aiRow = document.createElement('div');
    aiRow.className = 'grok-msg-row grok-msg-ai';
    const msgId = 'grok-ai-msg-' + Date.now();
    const requestId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

    aiRow.innerHTML = `
        <div class="grok-ai-bubble" id="${msgId}">
            <div class="grok-live-steps" id="live-${msgId}" aria-live="polite">
                <ol class="grok-live-list" id="live-list-${msgId}"></ol>
                <div class="grok-working-timer">
                    <i class="fa-solid fa-spinner fa-spin"></i> Working for <span class="grok-timer-sec" id="timer-${msgId}">1</span>s
                </div>
            </div>
        </div>
    `;

    grokChatStream.appendChild(aiRow);
    grokChatStream.scrollTop = grokChatStream.scrollHeight;

    let elapsedSeconds = 1;
    const timerInterval = setInterval(() => {
        elapsedSeconds++;
        const timerEl = document.getElementById(`timer-${msgId}`);
        if (timerEl) timerEl.textContent = elapsedSeconds;
    }, 1000);

    let liveShown = 0;
    let livePolling = true;
    const renderLiveSteps = (steps) => {
        const list = document.getElementById(`live-list-${msgId}`);
        if (!list || !Array.isArray(steps) || steps.length <= liveShown) return;
        for (const text of steps.slice(liveShown)) {
            const li = document.createElement('li');
            li.className = 'grok-live-step';
            li.textContent = text;
            list.appendChild(li);
        }
        liveShown = steps.length;
        grokChatStream.scrollTop = grokChatStream.scrollHeight;
    };
    (async function pollLiveSteps() {
        while (livePolling) {
            try {
                const r = await api.getAiProgress(authToken, requestId);
                if (!livePolling) break;
                renderLiveSteps(r && r.steps);
                if (r && r.done) break;
            } catch (e) { /* the answer still arrives without live steps */ }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    })();
    const stopLiveSteps = () => { livePolling = false; };

    const bubbleEl = document.getElementById(msgId);

    // 4. Route Execution to AI API
    try {
        const studentName = getCleanStudentName();
        const tutorMode = document.getElementById('grok-tutor-mode')?.value || 'tools';
        let toolNameBadge = '';
        let systemPrompt = `You are a personalized, world-class AI Study Companion inspired by Grok for ${studentName}. Naturally address the student warmly by name in your responses (e.g. "Hello ${studentName}!" or "Sure ${studentName}, let's solve this:"). Provide ultra-clear, intelligent, step-by-step academic explanations formatted with rich markdown, headings, bullet points, and LaTeX equations when applicable ($...$ for inline and $$...$$ for display math).`;

        let promptToSend = text;

        if (isDomainLookup || isSearchCmd) {
            toolNameBadge = `<div class="grok-tool-execution-badge"><i class="fa-solid fa-globe"></i> Web Search &amp; Domain Intelligence: ${escapeHtml(cleanTopic)}</div>`;
            systemPrompt = `You are a real-time web search and domain intelligence researcher inspired by Grok and Perplexity. Provide a comprehensive, professional, and structured research report on "${cleanTopic}".
Format your response in GitHub Markdown using this exact structure:

### 🔍 Research Overview & Status
Provide a transparent summary of the search status, domain reachability, and key findings. Include a Markdown table summarizing possibilities (e.g. Active Portal vs Under Development vs Private Portal, and What it means).

---

### 📋 Full Profile & Intelligence Report: "${cleanTopic}"
Use clear sections with emojis:
1️⃣ **Overview & Purpose**: Tagline, entity/organization that operates it, primary service and mission.
2️⃣ **Core Features & Services**: Registration flow, core tools, digital services, certificate/document downloads, integrations, and mobile/PWA availability.
3️⃣ **Target Audience & Use Cases**: Who uses it (students, developers, citizens, enterprises), regional vs global scope.
4️⃣ **Access & Navigation (Step-by-Step)**: Numbered step-by-step walkthrough from visiting the URL to logging in, using features, and accessing support.
5️⃣ **Requirements, Documents & Pro-Tips**: Supported browsers, required credentials/documents, speed requirements, and security guidelines.

---

### 🛠️ Actionable Research & Investigation Toolkit
Provide actionable tips on how to independently verify or investigate this domain (e.g., WHOIS lookups, search syntax like \`site:\`, public records, and contact channels).

---

### 📌 Bottom Line
Provide a clear, 2-sentence executive summary with recommended next steps.`;
        } else if (text.startsWith('/quiz') || text.toLowerCase().includes('quiz')) {
            toolNameBadge = '<div class="grok-tool-execution-badge"><i class="fa-solid fa-square-check"></i> Executed: AI Quiz Generator</div>';
            systemPrompt = "You are an expert examiner. Generate an interactive practice quiz on the requested topic. Provide 4 multiple-choice questions with options (A, B, C, D), correct answers, and clear step-by-step rationales.";
            promptToSend = text.replace('/quiz', '').trim();
        } else if (text.startsWith('/notes') || text.toLowerCase().includes('notes on')) {
            toolNameBadge = '<div class="grok-tool-execution-badge"><i class="fa-solid fa-book-bookmark"></i> Executed: Smart Note Taker</div>';
            systemPrompt = "You are a master educator. Create structured, high-yield study notes with Core Concepts, Key Formulas, Bulleted Highlights, Real-World Examples, and Common Exam Pitfalls.";
            promptToSend = text.replace('/notes', '').trim();
        } else if (text.startsWith('/solve') || isStemQuery) {
            toolNameBadge = '<div class="grok-tool-execution-badge"><i class="fa-solid fa-calculator"></i> Executed: Step-by-Step STEM Solver</div>';
            systemPrompt = "You are a master mathematics and physics professor. Solve step-by-step showing the core principle, each algebraic transformation, LaTeX equations ($...$ and $$...$$), and finish with a bold Final Answer.";
            promptToSend = text.replace('/solve', '').trim();
        } else if (text.startsWith('/flashcards') || text.toLowerCase().includes('flashcards')) {
            toolNameBadge = '<div class="grok-tool-execution-badge"><i class="fa-solid fa-clone"></i> Executed: Flashcard Creator</div>';
            systemPrompt = "Create a set of spaced-repetition flashcards formatted as Q: [Question] and A: [Answer] with crisp, memorable definitions.";
            promptToSend = text.replace('/flashcards', '').trim();
        } else if (text.startsWith('/research') || tutorMode === 'research') {
            toolNameBadge = '<div class="grok-tool-execution-badge"><i class="fa-solid fa-magnifying-glass-chart"></i> Executed: Deep Academic Research</div>';
            systemPrompt = "Perform a deep academic synthesis. Provide an Executive Summary, Key Findings, Scientific Evidence with inline citations [1], [2], Comparison of theories, and Conclusions.";
            promptToSend = text.replace('/research', '').trim();
        } else if (text.startsWith('/summary')) {
            toolNameBadge = '<div class="grok-tool-execution-badge"><i class="fa-solid fa-compress"></i> Executed: Multi-Format Summarizer</div>';
            systemPrompt = "Provide a high-impact summary with 5 core bullet takeaways, key definitions, and actionable study insights.";
            promptToSend = text.replace('/summary', '').trim();
        } else if (tutorMode === 'socratic') {
            systemPrompt = "You are a Socratic tutor. Guide the student to understanding by asking insightful leading questions, breaking concepts into smaller pieces, and validating their intuition.";
        }

        const res = await api.generateAI(authToken, promptToSend, systemPrompt, undefined, {
            threadId: activeChatThreadId,
            useMemory: true,
            requestId
        });
        if (res.threadId) activeChatThreadId = res.threadId;
        clearInterval(timerInterval);
        stopLiveSteps();

        const resultText = res.result || 'No response generated.';

        // Math-safe markdown — see renderAiMarkdown().
        const formattedContent = renderAiMarkdown(resultText);

        // Build Final Bubble Content
        // The finished panel keeps the same real steps, collapsed.
        const steps = Array.isArray(res.steps) ? res.steps : [];
        const retrievedCount = Array.isArray(res.sources) ? res.sources.length : 0;
        let thinkingHtml = '';
        if (steps.length) {
            thinkingHtml = `
                <div class="grok-think-pill-toggle" id="toggle-think-${msgId}">
                    <i class="fa-regular fa-lightbulb"></i> ${steps.length} step${steps.length === 1 ? '' : 's'} · ${elapsedSeconds}s <i class="fa-solid fa-chevron-down" style="font-size: 10px; margin-left: 4px;"></i>
                </div>
                <div class="grok-thinking-block" id="completed-think-${msgId}" style="display: none;">
                    <ol class="grok-live-list is-done">
                        ${steps.map(t => `<li class="grok-live-step">${escapeHtml(t)}</li>`).join('')}
                    </ol>
                </div>
            `;
        }

        // Real citations: these are the NCERT pages the server actually
        // retrieved and put in front of the model, not a decoration.
        let sourcesHtml = '';
        if (Array.isArray(res.sources) && res.sources.length) {
            const seen = new Set();
            const items = res.sources.filter(src => {
                const key = `${src.chapter}#${src.page}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            }).map(src => {
                const label = escapeHtml(`${src.chapter} · page ${src.page}`);
                return src.url
                    ? `<li><a href="${escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer">${label}</a></li>`
                    : `<li>${label}</li>`;
            }).join('');
            sourcesHtml = `
                <div class="grok-sources">
                    <div class="grok-sources-head"><i class="fa-solid ${res.memoryDoc ? 'fa-file-pdf' : 'fa-book-open'}"></i> ${
                        res.memoryDoc
                            ? `From your upload: ${escapeHtml(res.memoryDoc)}`
                            : res.selectedBook
                                ? `From ${escapeHtml(res.selectedBook)}`
                                : 'From your NCERT textbook'}</div>
                    <ul>${items}</ul>
                </div>`;
        }

        // Verified Source Library cards: built from the server's citation
        // records only (see sourceLibrary.js).
        const libraryHtml = window.SourceLibraryUI ? window.SourceLibraryUI.render(res) : '';

        // A study tool asked for in the chat comes back as a working card —
        // answerable worksheet, self-scoring quiz, flashcards (see chatTools.js).
        const toolHtml = window.ChatToolsUI ? window.ChatToolsUI.render(res) : '';

        bubbleEl.innerHTML = `
            ${toolNameBadge}
            ${thinkingHtml}
            <div class="grok-response-body">${formattedContent}</div>
            ${toolHtml}
            ${libraryHtml}
            ${sourcesHtml}
            <div class="grok-msg-actions">
                <button type="button" class="grok-msg-btn grok-copy-btn" title="Copy response to clipboard">
                    <i class="fa-regular fa-copy"></i> Copy
                </button>
                <button type="button" class="grok-msg-btn grok-listen-btn" title="Listen aloud">
                    <i class="fa-solid fa-volume-high"></i> Listen Aloud
                </button>
                <button type="button" class="grok-msg-btn grok-savenote-btn" title="Save response to Note Taker">
                    <i class="fa-solid fa-bookmark"></i> Save to Notes
                </button>
                <button type="button" class="grok-msg-btn grok-quizme-btn" title="Quiz me on this topic">
                    <i class="fa-solid fa-lightbulb"></i> Quiz Me
                </button>
                <button type="button" class="grok-msg-btn grok-eli5-btn" title="Explain in simpler terms">
                    <i class="fa-solid fa-child"></i> Explain Simpler
                </button>
            </div>
        `;

        // The tutor answers maths in LaTeX; without this it renders as raw
        // "$$\frac{\sin i}{\sin r}$$" in the bubble.
        renderChatMath(bubbleEl);
        if (window.SourceLibraryUI) window.SourceLibraryUI.wire(bubbleEl);
        if (window.ChatToolsUI) window.ChatToolsUI.wire(bubbleEl);

        // Toggle thinking step visibility
        if (thinkingHtml) {
            const toggleBtn = document.getElementById(`toggle-think-${msgId}`);
            const thinkBox = document.getElementById(`completed-think-${msgId}`);
            toggleBtn?.addEventListener('click', () => {
                const isHidden = thinkBox.style.display === 'none';
                thinkBox.style.display = isHidden ? 'block' : 'none';
                toggleBtn.querySelector('.fa-chevron-down, .fa-chevron-up').className = isHidden ? 'fa-solid fa-chevron-up' : 'fa-solid fa-chevron-down';
            });
        }

        // Wire up response action buttons
        bubbleEl.querySelector('.grok-copy-btn')?.addEventListener('click', () => {
            navigator.clipboard.writeText(resultText);
            showToast('Copied to clipboard! 📋', 'success');
        });

        const listenBtn = bubbleEl.querySelector('.grok-listen-btn');
        const defaultListenHtml = '<i class="fa-solid fa-volume-high"></i> Listen Aloud';
        listenBtn?.addEventListener('click', async () => {
            if (globalVoicePlayer.currentBtn === listenBtn && globalVoicePlayer.isPlaying()) {
                globalVoicePlayer.stop();
                showToast('Voice playback stopped', 'info');
                return;
            }

            listenBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Getting your voice ready...';
            try {
                const studentName = getCleanStudentName();
                const ttsRes = await api.textToSpeech(authToken, resultText, 'hi-IN', 'shubh', 1.05, studentName);
                if (ttsRes.success && ttsRes.audio) {
                    listenBtn.innerHTML = '<i class="fa-solid fa-circle-stop fa-fade" style="color:#EF4444;"></i> Stop Voice';
                    showToast("You're doing great — here's your answer read aloud 🔊", 'info');
                    globalVoicePlayer.play(ttsRes.audio, listenBtn, defaultListenHtml);
                } else {
                    throw new Error('No audio returned');
                }
            } catch (err) {
                console.error('Voice playback error:', err);
                listenBtn.innerHTML = defaultListenHtml;
                showToast("Voice playback isn't available right now — please try again in a moment.", 'error');
            }
        });

        bubbleEl.querySelector('.grok-savenote-btn')?.addEventListener('click', () => {
            const noteTitle = text.length > 30 ? text.substring(0, 30) + '...' : text;
            const newNote = {
                id: 'note_' + Date.now(),
                title: 'AI Companion: ' + noteTitle,
                content: resultText,
                date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            };
            try {
                const existing = JSON.parse(localStorage.getItem('studyUserNotes') || '[]');
                existing.unshift(newNote);
                localStorage.setItem('studyUserNotes', JSON.stringify(existing));
                showToast('Saved note to Smart Note Taker! 📝', 'success');
            } catch(e) {}
        });

        bubbleEl.querySelector('.grok-quizme-btn')?.addEventListener('click', () => {
            if (grokChatInput) {
                grokChatInput.value = `/quiz Generate a 3-question practice quiz based on: "${text.substring(0, 50)}"`;
                sendGrokMessage();
            }
        });

        bubbleEl.querySelector('.grok-eli5-btn')?.addEventListener('click', () => {
            if (grokChatInput) {
                grokChatInput.value = `Explain this in extremely simple, intuitive terms like I am 10 years old with an easy analogy:\n"${text.substring(0, 100)}"`;
                sendGrokMessage();
            }
        });

        // Let the sidebar re-sort the chat list and pick up a new chat's title.
        document.dispatchEvent(new CustomEvent('companion:turn', { detail: { threadId: activeChatThreadId } }));

        // Award XP for study interaction
        api.addXp(authToken, 25, 5, 'AI Study Session').then(r => applyXpResult(r));

    } catch (err) {
        clearInterval(timerInterval);
        stopLiveSteps();
        console.error(err);
        bubbleEl.innerHTML = `
            <div style="color: #EF4444; font-size: 13.5px;">
                <i class="fa-solid fa-triangle-exclamation"></i> Error communicating with AI: ${escapeHtml(err.message || 'Please check your connection and retry.')}
            </div>
        `;
    }

    grokChatStream.scrollTop = grokChatStream.scrollHeight;
}

grokSendBtn?.addEventListener('click', sendGrokMessage);

grokChatInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendGrokMessage();
    }
});

// ============================================================================
// COMPLETE GOOGLE CLASSROOM-STYLE TEACHER HUB & CLASSROOM CONTROLLER
// ============================================================================

let currentPortal = 'student'; // 'student' | 'teacher' | 'developer'
let activeTeacherClasses = [];
let selectedTeacherClassId = null;
let currentStudentClassId = null;
let currentEditingWorksheet = null;
let activeWorksheetTimer = null;

// --- Portal Switcher Function ---
function switchPortal(portal, updateUrl = true) {
    if (!isAuthenticated()) {
        showLandingOnly();
        return;
    }
    const studentApp = document.getElementById('app-container');
    const devApp = document.getElementById('developer-portal-container');
    const teacherApp = document.getElementById('teacher-portal-container');
    const landingPage = document.getElementById('landing-page');

    if (portal === 'teacher') {
        // Teacher Hub is a separate account type, not a mode a student can
        // toggle into. Offer the sign-in instead of a dead end — and do NOT
        // persist the denied portal, or every reload bounces the student
        // back into this modal.
        const user = JSON.parse(localStorage.getItem('studyUser') || '{}');
        if (user && user.role === 'student') {
            showToast('Teacher Hub requires a teacher account.', 'info');
            return;
        }
    }

    currentPortal = portal;
    localStorage.setItem('activePortalMode', portal);

    if (landingPage) landingPage.style.display = 'none';

    if (portal === 'teacher') {
        if (studentApp) studentApp.style.display = 'none';
        if (devApp) devApp.style.display = 'none';
        if (teacherApp) teacherApp.style.display = 'flex';
        const savedTab = localStorage.getItem('activeTeacherTab') || 'dashboard';
        // Tab loaders read activeTeacherClasses, so the portal data has to
        // land before the tab renders — otherwise a refresh straight into
        // /teacher/<tab> shows an empty pane.
        loadTeacherPortal().then(() => switchTeacherTab(savedTab, updateUrl));
    } else if (portal === 'developer') {
        if (studentApp) studentApp.style.display = 'none';
        if (teacherApp) teacherApp.style.display = 'none';
        if (devApp) devApp.style.display = 'flex';
        if (typeof initDeveloperPortal === 'function') initDeveloperPortal();
        if (updateUrl) syncUrl('/developer');
    } else {
        // Default to student
        if (devApp) devApp.style.display = 'none';
        if (teacherApp) teacherApp.style.display = 'none';
        if (studentApp) studentApp.style.display = 'flex';
        const activeNav = document.querySelector('.sidebar .nav-item.active');
        const target = activeNav ? activeNav.getAttribute('data-target') : 'dashboard';
        navigateToSection(target, updateUrl);
    }
}

// Portals are role-locked: an account is a student, a teacher or a developer,
// and the server enforces that on login. There is deliberately no in-app
// switcher — changing portal means logging out and signing in with that
// account. switchPortal() remains for routing/restore only.

// Teacher Mobile Drawer Toggle
const teacherMobileToggleBtn = document.getElementById('teacher-mobile-toggle-btn');
const teacherSidebarBackdrop = document.getElementById('teacher-sidebar-backdrop');
const teacherSidebarEl = document.getElementById('teacher-sidebar');

if (teacherMobileToggleBtn && teacherSidebarEl) {
    teacherMobileToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        teacherSidebarEl.classList.toggle('open');
        teacherSidebarBackdrop?.classList.toggle('active');
    });
}
if (teacherSidebarBackdrop && teacherSidebarEl) {
    teacherSidebarBackdrop.addEventListener('click', () => {
        teacherSidebarEl.classList.remove('open');
        teacherSidebarBackdrop.classList.remove('active');
    });
}

// Teacher Sidebar Navigation
document.querySelectorAll('.teacher-nav-item').forEach(item => {
    item.addEventListener('click', () => {
        const tab = item.getAttribute('data-teacher-tab');
        switchTeacherTab(tab, true);
        // Auto-close on mobile
        teacherSidebarEl?.classList.remove('open');
        teacherSidebarBackdrop?.classList.remove('active');
    });
});

function switchTeacherTab(tabName, updateUrl = true) {
    document.querySelectorAll('.teacher-nav-item').forEach(el => {
        el.classList.toggle('active', el.getAttribute('data-teacher-tab') === tabName);
    });
    document.querySelectorAll('.teacher-tab-pane').forEach(pane => {
        pane.classList.remove('active');
        pane.style.display = 'none';
    });
    const targetPane = document.getElementById(`teacher-tab-${tabName}`);
    if (targetPane) {
        targetPane.classList.add('active');
        targetPane.style.display = 'block';
    }

    localStorage.setItem('activeTeacherTab', tabName);
    if (updateUrl) {
        syncUrl(tabName === 'dashboard' ? '/teacher' : `/teacher/${tabName}`);
    }

    // Refresh specific tab contents
    if (tabName === 'classes') renderTeacherAllClasses();
    if (tabName === 'homework') loadTeacherHomeworkTab();
    if (tabName === 'notes') loadTeacherNotesTab();
    if (tabName === 'announcements') loadTeacherAnnouncementsTab();
    if (tabName === 'people') loadTeacherPeopleTab();
}

// ============================================================================
// TEACHER HUB PORTAL IMPLEMENTATION
// ============================================================================
async function loadTeacherPortal() {
    if (!authToken) return;
    try {
        // Set user name
        const greetingEl = document.getElementById('teacher-greeting-name');
        const userPillName = document.getElementById('teacher-user-name');
        const user = JSON.parse(localStorage.getItem('studyUser') || '{}');
        const name = user.username ? (user.username.includes('@') ? user.username.split('@')[0] : user.username) : 'Teacher';
        if (greetingEl) greetingEl.textContent = name;
        if (userPillName) userPillName.textContent = name;

        const res = await api.getTeacherClasses(authToken);
        activeTeacherClasses = res.classes || [];

        // Update stats
        const statClasses = document.getElementById('teacher-stat-classes');
        const statStudents = document.getElementById('teacher-stat-students');
        const statHw = document.getElementById('teacher-stat-hw');
        const statWs = document.getElementById('teacher-stat-worksheets');

        let totalStudents = 0;
        activeTeacherClasses.forEach(c => { totalStudents += (c.student_count || 0); });

        if (statClasses) statClasses.textContent = activeTeacherClasses.length;
        if (statStudents) statStudents.textContent = totalStudents;

        // Homework and worksheet tiles were read but never assigned, so they
        // sat at 0 forever. The overview endpoint supplies both, plus the
        // "needs attention" queue.
        try {
            const { stats, needsAttention } = await api.getTeacherOverview(authToken);
            if (statHw) statHw.textContent = stats.activeHomework;
            if (statWs) statWs.textContent = stats.publishedWorksheets;
            if (statClasses) statClasses.textContent = stats.classes;
            if (statStudents) statStudents.textContent = stats.students;
            renderTeacherAttention(needsAttention, stats);
        } catch (e) {
            console.warn('[TEACHER OVERVIEW]', e.message);
        }

        // Populate Class Selector Dropdowns
        populateTeacherClassDropdowns();

        // Render Classroom cards on dashboard
        renderTeacherDashboardClasses();
    } catch (err) {
        console.error('[LOAD TEACHER PORTAL ERROR]', err);
    }
}

function populateTeacherClassDropdowns() {
    const selectors = [
        'teacher-active-class-select',
        'hw-target-class-select',
        'ws-target-class-select',
        'note-target-class-select',
        'ann-target-class-select'
    ];

    selectors.forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        sel.innerHTML = activeTeacherClasses.length === 0
            ? '<option value="">No classes found (Create one first)</option>'
            : activeTeacherClasses.map(c => `<option value="${c.id}">${c.name}-${c.section} · ${c.subject || 'All'}</option>`).join('');
        if (selectedTeacherClassId) {
            sel.value = selectedTeacherClassId;
        }
    });

    if (activeTeacherClasses.length > 0 && !selectedTeacherClassId) {
        selectedTeacherClassId = activeTeacherClasses[0].id;
    }
}

document.getElementById('teacher-active-class-select')?.addEventListener('change', (e) => {
    selectedTeacherClassId = parseInt(e.target.value);
});

function renderTeacherDashboardClasses() {
    renderTeacherClassGrid('teacher-classes-grid');
    renderTeacherClassGrid('teacher-all-classes-grid');
}

function renderTeacherClassGrid(gridId) {
    const grid = document.getElementById(gridId);
    if (!grid) return;

    if (activeTeacherClasses.length === 0) {
        grid.innerHTML = `
            <div class="classroom-empty-state" style="grid-column: 1 / -1;">
                <div class="classroom-empty-icon"><i class="fa-solid fa-chalkboard-user"></i></div>
                <h3>No classrooms created yet</h3>
                <p>Create your first class section (e.g. Class 9-A) to get a unique 6-digit class code for students.</p>
                <button class="btn btn-primary" onclick="openCreateClassModal()" style="margin-top: 14px;">
                    <i class="fa-solid fa-plus"></i> Create Classroom Now
                </button>
            </div>
        `;
        return;
    }

    grid.innerHTML = activeTeacherClasses.map(c => `
        <div class="class-card" onclick="openTeacherClassDetail(${c.id})">
            <div class="class-card-header">
                <h3 class="class-card-title">${escapeHtml(c.name)} - Section ${escapeHtml(c.section)}</h3>
                <div class="class-card-sub">${escapeHtml(c.subject || 'All Subjects')} &bull; ${escapeHtml(c.academic_year || '2026-27')}</div>
                <div class="class-card-code-pill" onclick="event.stopPropagation(); copyTextToClipboard('${c.class_code}', 'Class Code copied!')">
                    <i class="fa-solid fa-key"></i> Code: ${c.class_code} <i class="fa-regular fa-copy" style="margin-left: 4px;"></i>
                </div>
            </div>
            <div class="class-card-body">
                <div class="class-card-meta-row">
                    <span><i class="fa-solid fa-user-graduate"></i> Enrolled Students</span>
                    <strong>${c.student_count || 0} Students</strong>
                </div>
                <div class="class-card-meta-row">
                    <span><i class="fa-solid fa-user-tie"></i> Role</span>
                    <strong style="color: #2563EB; text-transform: capitalize;">${c.my_role || 'Teacher'}</strong>
                </div>
            </div>
            <div class="class-card-footer">
                <span style="font-size: 12.5px; font-weight: 700; color: #2563EB;">Manage Classroom <i class="fa-solid fa-arrow-right"></i></span>
            </div>
        </div>
    `).join('');
}

async function renderTeacherAllClasses() {
    // Copying the dashboard grid's HTML broke when that grid hadn't rendered
    // yet (deep link straight to /teacher/classes), so render from the data.
    if (!activeTeacherClasses || activeTeacherClasses.length === 0) {
        try {
            const res = await api.getTeacherClasses(authToken);
            activeTeacherClasses = res.classes || [];
        } catch (e) {
            console.warn('[TEACHER CLASSES]', e.message);
        }
    }
    renderTeacherClassGrid('teacher-all-classes-grid');
}

function openTeacherClassDetail(classId) {
    selectedTeacherClassId = classId;
    const activeSel = document.getElementById('teacher-active-class-select');
    if (activeSel) activeSel.value = classId;
    switchTeacherTab('homework');
}

// Teacher Create Class Modal
function openCreateClassModal() {
    const modal = document.getElementById('create-class-modal');
    if (modal) modal.style.display = 'flex';
}
function closeCreateClassModal() {
    const modal = document.getElementById('create-class-modal');
    if (modal) modal.style.display = 'none';
}
document.getElementById('teacher-hero-create-btn')?.addEventListener('click', openCreateClassModal);
document.getElementById('teacher-pane-create-btn')?.addEventListener('click', openCreateClassModal);
document.getElementById('teacher-create-class-sidebar-btn')?.addEventListener('click', openCreateClassModal);
document.getElementById('close-create-class-modal-btn')?.addEventListener('click', closeCreateClassModal);

document.getElementById('submit-create-class-btn')?.addEventListener('click', async () => {
    const name = document.getElementById('create-class-name')?.value?.trim();
    const section = document.getElementById('create-class-section')?.value?.trim();
    const subject = document.getElementById('create-class-subject')?.value?.trim();
    const academic_year = document.getElementById('create-class-year')?.value?.trim();
    const description = document.getElementById('create-class-desc')?.value?.trim();

    if (!name || !section) {
        showToast('Please enter Class Name and Section', 'error');
        return;
    }

    try {
        const res = await api.createTeacherClass(authToken, { name, section, subject, academic_year, description });
        showToast(`Classroom ${name}-${section} created with code: ${res.classroom.class_code} 🎉`, 'success');
        closeCreateClassModal();
        loadTeacherPortal();
    } catch (err) {
        showToast(err.message || 'Failed to create classroom', 'error');
    }
});

// Teacher Join Class Modal (Co-teacher)
function openTeacherJoinModal() {
    const modal = document.getElementById('teacher-join-modal');
    if (modal) modal.style.display = 'flex';
}
function closeTeacherJoinModal() {
    const modal = document.getElementById('teacher-join-modal');
    if (modal) modal.style.display = 'none';
}
document.getElementById('teacher-hero-join-btn')?.addEventListener('click', openTeacherJoinModal);
document.getElementById('teacher-pane-join-btn')?.addEventListener('click', openTeacherJoinModal);
document.getElementById('teacher-join-class-sidebar-btn')?.addEventListener('click', openTeacherJoinModal);
document.getElementById('close-teacher-join-modal-btn')?.addEventListener('click', closeTeacherJoinModal);

document.getElementById('submit-teacher-join-btn')?.addEventListener('click', async () => {
    const classCode = document.getElementById('teacher-join-code-input')?.value?.trim();
    const subject = document.getElementById('teacher-join-subject-input')?.value?.trim();

    if (!classCode) {
        showToast('Please enter the class code', 'error');
        return;
    }

    try {
        const res = await api.joinTeacherClass(authToken, classCode, subject, 'subject_teacher');
        showToast(`Joined ${res.classroom.name}-${res.classroom.section} as Subject Teacher! 👨‍🏫`, 'success');
        closeTeacherJoinModal();
        loadTeacherPortal();
    } catch (err) {
        showToast(err.message || 'Failed to join class', 'error');
    }
});

// --- Homework Manager Controller ---
document.getElementById('teacher-open-create-hw-btn')?.addEventListener('click', () => {
    const card = document.getElementById('teacher-create-hw-card');
    if (card) card.style.display = card.style.display === 'none' ? 'block' : 'none';
});
document.getElementById('hw-cancel-create-btn')?.addEventListener('click', () => {
    const card = document.getElementById('teacher-create-hw-card');
    if (card) card.style.display = 'none';
});

document.getElementById('hw-submit-assign-btn')?.addEventListener('click', async () => {
    const classId = document.getElementById('hw-target-class-select')?.value;
    const subject = document.getElementById('hw-subject-input')?.value?.trim();
    const title = document.getElementById('hw-title-input')?.value?.trim();
    const instructions = document.getElementById('hw-instructions-input')?.value?.trim();
    const due_date = document.getElementById('hw-duedate-input')?.value;
    const due_time = document.getElementById('hw-duetime-input')?.value;
    const max_marks = parseInt(document.getElementById('hw-maxmarks-input')?.value) || 20;

    if (!classId || !title || !subject) {
        showToast('Class, Subject, and Homework Title are required', 'error');
        return;
    }

    try {
        await api.createTeacherHomework(authToken, { classId, subject, title, instructions, due_date, due_time, max_marks });
        showToast('Homework assigned and notified to all enrolled students! 🚀', 'success');
        document.getElementById('teacher-create-hw-card').style.display = 'none';
        loadTeacherHomeworkTab();
    } catch (err) {
        showToast(err.message || 'Failed to assign homework', 'error');
    }
});

async function loadTeacherHomeworkTab() {
    const list = document.getElementById('teacher-hw-list');
    if (!list || !activeTeacherClasses.length) return;
    const classId = selectedTeacherClassId || activeTeacherClasses[0]?.id;
    if (!classId) return;

    try {
        const res = await api.getTeacherClassDetails(authToken, classId);
        const homework = res.stream?.homework || [];

        if (homework.length === 0) {
            list.innerHTML = `
                <div class="classroom-empty-state">
                    <i class="fa-solid fa-book-open" style="font-size: 32px; color: var(--text-secondary);"></i>
                    <h4 style="margin: 10px 0 4px;">No Homework Assigned Yet</h4>
                    <p>Click "+ Assign Homework" above to publish tasks and set deadlines.</p>
                </div>
            `;
            return;
        }

        list.innerHTML = homework.map(h => `
            <div class="hw-card">
                <div>
                    <h3 style="margin: 0; font-size: 16px; font-weight: 800; color: var(--text-primary);">${escapeHtml(h.title)}</h3>
                    <div style="font-size: 13px; color: var(--text-secondary); margin-top: 4px;">
                        <span><i class="fa-solid fa-book"></i> ${escapeHtml(h.subject)}</span> &bull; 
                        <span><i class="fa-solid fa-star"></i> ${h.max_marks || 100} Marks</span> &bull;
                        <span class="hw-due-pill"><i class="fa-solid fa-calendar"></i> Due: ${h.due_date || 'No deadline'} ${h.due_time || ''}</span>
                    </div>
                    <p style="font-size: 13.5px; color: var(--text-primary); margin-top: 8px; white-space: pre-wrap;">${escapeHtml(h.instructions || '')}</p>
                </div>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span class="status-pill-submitted">${h.submission_count || 0} Submissions</span>
                    <button class="btn btn-secondary" onclick="viewHomeworkSubmissions(${h.id})" style="font-size: 13px; padding: 8px 14px;">
                        <i class="fa-solid fa-eye"></i> View &amp; Grade
                    </button>
                </div>
            </div>
        `).join('');
    } catch (err) {
        console.error('[LOAD TEACHER HW ERROR]', err);
    }
}

async function viewHomeworkSubmissions(homeworkId) {
    try {
        const res = await api.getHomeworkSubmissions(authToken, homeworkId);
        const submissions = res.submissions || [];
        if (submissions.length === 0) {
            showToast('No students have turned in this homework yet.', 'info');
            return;
        }
        openGradeModal(submissions[0], res.homework);
    } catch (err) {
        showToast(err.message || 'Failed to fetch submissions', 'error');
    }
}

function openGradeModal(submission, homework) {
    const modal = document.getElementById('grade-submission-modal');
    if (!modal) return;
    document.getElementById('grade-student-meta').textContent = `Student: ${submission.student_name} • Homework: ${homework.title}`;
    document.getElementById('grade-submitted-content').textContent = submission.content || 'No text content';
    document.getElementById('grade-max-marks').value = `${homework.max_marks || 100} Marks`;
    document.getElementById('grade-marks-input').value = submission.marks !== null ? submission.marks : '';
    document.getElementById('grade-feedback-input').value = submission.feedback || '';

    modal.style.display = 'flex';

    document.getElementById('grade-submit-btn').onclick = async () => {
        const marks = parseFloat(document.getElementById('grade-marks-input').value);
        const feedback = document.getElementById('grade-feedback-input').value;
        if (isNaN(marks)) {
            showToast('Please enter valid marks', 'error');
            return;
        }
        try {
            await api.gradeHomeworkSubmission(authToken, submission.id, marks, feedback);
            showToast('Graded successfully and student notified! 🌟', 'success');
            modal.style.display = 'none';
        } catch (err) {
            showToast(err.message || 'Failed to grade submission', 'error');
        }
    };
}
document.getElementById('close-grade-modal-btn')?.addEventListener('click', () => {
    document.getElementById('grade-submission-modal').style.display = 'none';
});

// --- AI Worksheet Generator & Live Editor ---
document.getElementById('teacher-generate-ws-btn')?.addEventListener('click', async () => {
    const classId = document.getElementById('ws-target-class-select')?.value;
    const subject = document.getElementById('ws-subject-input')?.value?.trim();
    const topic = document.getElementById('ws-topic-input')?.value?.trim();
    const difficulty = document.getElementById('ws-difficulty-select')?.value;
    const questionTypes = document.getElementById('ws-types-select')?.value;
    const numQuestions = parseInt(document.getElementById('ws-num-questions')?.value) || 5;
    const duration = parseInt(document.getElementById('ws-duration')?.value) || 20;

    if (!subject || !topic) {
        showToast('Please provide Subject and Topic', 'error');
        return;
    }

    const btn = document.getElementById('teacher-generate-ws-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating Pedagogical AI Worksheet...';

    try {
        const res = await api.generateAIWorksheet(authToken, {
            subject, topic, difficulty, questionTypes, numQuestions, duration
        });

        currentEditingWorksheet = {
            classId,
            subject,
            topic,
            difficulty,
            duration,
            ...res.worksheet
        };

        renderWorksheetEditor(currentEditingWorksheet);
        showToast('AI Worksheet generated! Preview and edit below before publishing.', 'success');
    } catch (err) {
        showToast(err.message || 'Failed to generate worksheet', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Generate AI Worksheet';
    }
});

function renderWorksheetEditor(ws) {
    const card = document.getElementById('ws-editor-preview-card');
    const titleEl = document.getElementById('ws-preview-title');
    const metaEl = document.getElementById('ws-preview-meta');
    const list = document.getElementById('ws-questions-editor-list');
    if (!card || !list) return;

    titleEl.textContent = ws.title || 'Practice Worksheet';
    metaEl.textContent = `${ws.subject} • ${ws.questions?.length || 0} Questions • Total Marks: ${ws.total_marks || 20} • ${ws.duration || 20} Mins`;

    const questions = ws.questions || [];
    list.innerHTML = questions.map((q, idx) => `
        <div class="ws-q-edit-card" data-q-index="${idx}">
            <div class="ws-q-edit-top">
                <span class="ws-q-badge">Question ${idx + 1} (${q.type?.toUpperCase() || 'MCQ'})</span>
                <button type="button" class="btn-action-remove" onclick="deleteWorksheetQuestion(${idx})"><i class="fa-solid fa-trash"></i> Delete</button>
            </div>
            <div class="form-group" style="margin-bottom: 10px;">
                <label style="font-size: 12px; font-weight: 700;">Question Text</label>
                <input type="text" class="form-control ws-q-text" value="${escapeHtml(q.question || '')}" onchange="updateQuestionField(${idx}, 'question', this.value)">
            </div>
            ${q.options && q.options.length ? `
                <div class="form-group" style="margin-bottom: 10px;">
                    <label style="font-size: 12px; font-weight: 700;">Options (Comma separated)</label>
                    <input type="text" class="form-control" value="${escapeHtml(q.options.join(', '))}" onchange="updateQuestionOptions(${idx}, this.value)">
                </div>
            ` : ''}
            <div class="form-row-2">
                <div class="form-group">
                    <label style="font-size: 12px; font-weight: 700;">Correct Answer / Key</label>
                    <input type="text" class="form-control" value="${escapeHtml(q.correct_answer || '')}" onchange="updateQuestionField(${idx}, 'correct_answer', this.value)">
                </div>
                <div class="form-group">
                    <label style="font-size: 12px; font-weight: 700;">Marks</label>
                    <input type="number" class="form-control" value="${q.marks || 2}" onchange="updateQuestionField(${idx}, 'marks', parseInt(this.value))">
                </div>
            </div>
        </div>
    `).join('');

    card.style.display = 'block';
}

window.deleteWorksheetQuestion = function(idx) {
    if (!currentEditingWorksheet || !currentEditingWorksheet.questions) return;
    currentEditingWorksheet.questions.splice(idx, 1);
    renderWorksheetEditor(currentEditingWorksheet);
};

window.updateQuestionField = function(idx, field, val) {
    if (currentEditingWorksheet && currentEditingWorksheet.questions[idx]) {
        currentEditingWorksheet.questions[idx][field] = val;
    }
};

window.updateQuestionOptions = function(idx, val) {
    if (currentEditingWorksheet && currentEditingWorksheet.questions[idx]) {
        currentEditingWorksheet.questions[idx].options = val.split(',').map(s => s.trim());
    }
};

document.getElementById('ws-add-question-btn')?.addEventListener('click', () => {
    if (!currentEditingWorksheet) return;
    currentEditingWorksheet.questions = currentEditingWorksheet.questions || [];
    currentEditingWorksheet.questions.push({
        id: currentEditingWorksheet.questions.length + 1,
        type: 'mcq',
        question: 'New Question',
        options: ['Option A', 'Option B', 'Option C', 'Option D'],
        correct_answer: 'Option A',
        marks: 2
    });
    renderWorksheetEditor(currentEditingWorksheet);
});

document.getElementById('ws-publish-to-class-btn')?.addEventListener('click', async () => {
    if (!currentEditingWorksheet) return;
    const classId = document.getElementById('ws-target-class-select')?.value || currentEditingWorksheet.classId;

    try {
        await api.publishAIWorksheet(authToken, {
            classId,
            title: currentEditingWorksheet.title,
            subject: currentEditingWorksheet.subject,
            topic: currentEditingWorksheet.topic,
            difficulty: currentEditingWorksheet.difficulty,
            total_marks: currentEditingWorksheet.total_marks || 20,
            duration: currentEditingWorksheet.duration || 20,
            worksheet_data: currentEditingWorksheet
        });
        showToast('Worksheet published to classroom and available to all enrolled students! 🌟', 'success');
        document.getElementById('ws-editor-preview-card').style.display = 'none';
        currentEditingWorksheet = null;
    } catch (err) {
        showToast(err.message || 'Failed to publish worksheet', 'error');
    }
});

// --- Differentiated Test Generator (Easy / Medium / Hard) ---
let currentDifferentiatedVersions = null;
let currentDiffLevel = 'easy';

document.getElementById('teacher-generate-diff-btn')?.addEventListener('click', async () => {
    const classId = document.getElementById('ws-target-class-select')?.value;
    const subject = document.getElementById('ws-subject-input')?.value?.trim();
    const topic = document.getElementById('ws-topic-input')?.value?.trim();
    const numQuestions = parseInt(document.getElementById('ws-num-questions')?.value) || 6;
    const duration = parseInt(document.getElementById('ws-duration')?.value) || 30;

    if (!subject || !topic) {
        showToast('Please provide Subject and Topic first', 'error');
        return;
    }

    const btn = document.getElementById('teacher-generate-diff-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Writing 3 differentiated versions...';

    try {
        const res = await api.generateDifferentiatedTests(authToken, { subject, topic, numQuestions, duration });
        currentDifferentiatedVersions = { classId, subject, topic, duration, ...res.versions };
        currentDiffLevel = 'easy';
        document.getElementById('diff-test-preview-card').style.display = 'block';
        renderDiffTestTab('easy');
        showToast('All 3 difficulty levels generated! Pick a level to preview and publish.', 'success');
    } catch (err) {
        showToast(err.message || 'Failed to generate differentiated test', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-layer-group"></i> Generate Differentiated Test (Easy / Medium / Hard)';
    }
});

document.querySelectorAll('.diff-tab-btn').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.diff-tab-btn').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        renderDiffTestTab(tab.getAttribute('data-level'));
    });
});

function renderDiffTestTab(level) {
    currentDiffLevel = level;
    const body = document.getElementById('diff-test-body');
    if (!currentDifferentiatedVersions || !body) return;
    const version = currentDifferentiatedVersions[level];
    if (!version) return;

    body.innerHTML = `
        <h4 style="font-weight:800; margin: 14px 0 6px; color: var(--text-primary);">${escapeHtml(version.title || `${level} version`)}</h4>
        <p style="font-size:13px; color: var(--text-secondary); margin-bottom: 14px;">${(version.questions || []).length} questions &bull; ${version.total_marks || 20} marks &bull; ${version.duration || currentDifferentiatedVersions.duration} min</p>
        <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:18px;">
            ${(version.questions || []).map((q, i) => `
                <div style="padding:12px 14px; background: var(--bg-color); border-radius:10px; border: 1px solid var(--border-color);">
                    <p style="font-weight:700; font-size:13.5px; margin-bottom:4px;">${i + 1}. ${escapeHtml(q.question)}</p>
                    ${(q.options && q.options.length) ? `<p style="font-size:12.5px; color: var(--text-secondary);">${q.options.map(escapeHtml).join(' &nbsp;•&nbsp; ')}</p>` : ''}
                    <p style="font-size:12px; color: var(--success-color); margin-top:4px;"><i class="fa-solid fa-check"></i> ${escapeHtml(q.correct_answer || '')}</p>
                </div>
            `).join('')}
        </div>
        <button class="btn btn-primary" id="diff-load-editor-btn" style="width:100%;">
            <i class="fa-solid fa-pen-to-square"></i> Load "${level.charAt(0).toUpperCase() + level.slice(1)}" into Editor to Publish
        </button>
    `;

    document.getElementById('diff-load-editor-btn')?.addEventListener('click', () => {
        currentEditingWorksheet = {
            classId: currentDifferentiatedVersions.classId,
            subject: currentDifferentiatedVersions.subject,
            topic: currentDifferentiatedVersions.topic,
            difficulty: level.charAt(0).toUpperCase() + level.slice(1),
            duration: currentDifferentiatedVersions.duration,
            ...version
        };
        renderWorksheetEditor(currentEditingWorksheet);
        document.getElementById('ws-editor-preview-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        showToast(`${level.charAt(0).toUpperCase() + level.slice(1)} version loaded — review below, then publish.`, 'info');
    });
}

// --- Study Notes Publisher ---
document.getElementById('teacher-open-create-note-btn')?.addEventListener('click', () => {
    const card = document.getElementById('teacher-create-note-card');
    if (card) card.style.display = card.style.display === 'none' ? 'block' : 'none';
});
document.getElementById('note-cancel-create-btn')?.addEventListener('click', () => {
    const card = document.getElementById('teacher-create-note-card');
    if (card) card.style.display = 'none';
});

document.getElementById('note-submit-publish-btn')?.addEventListener('click', async () => {
    const classId = document.getElementById('note-target-class-select')?.value;
    const subject = document.getElementById('note-subject-input')?.value?.trim();
    const title = document.getElementById('note-title-input')?.value?.trim();
    const content = document.getElementById('note-content-input')?.value?.trim();

    if (!classId || !title || !content) {
        showToast('Class, Title, and Note Content are required', 'error');
        return;
    }

    try {
        await api.createTeacherNote(authToken, { classId, subject, title, content });
        showToast('Study note published to class! 📚', 'success');
        document.getElementById('teacher-create-note-card').style.display = 'none';
        loadTeacherNotesTab();
    } catch (err) {
        showToast(err.message || 'Failed to publish note', 'error');
    }
});

async function loadTeacherNotesTab() {
    const grid = document.getElementById('teacher-notes-grid');
    if (!grid || !activeTeacherClasses.length) return;
    const classId = selectedTeacherClassId || activeTeacherClasses[0]?.id;

    try {
        const res = await api.getTeacherClassDetails(authToken, classId);
        const notes = res.stream?.notes || [];
        if (notes.length === 0) {
            grid.innerHTML = `
                <div class="classroom-empty-state" style="grid-column: 1 / -1;">
                    <i class="fa-solid fa-file-lines" style="font-size: 32px; color: var(--text-secondary);"></i>
                    <h4 style="margin: 10px 0 4px;">No Study Notes Published</h4>
                    <p>Click "+ New Note" to share chapter summaries and formula sheets.</p>
                </div>
            `;
            return;
        }

        grid.innerHTML = notes.map(n => `
            <div class="note-card">
                <div>
                    <h3 style="margin: 0; font-size: 16px; font-weight: 800; color: var(--text-primary);">${escapeHtml(n.title)}</h3>
                    <div style="font-size: 12.5px; color: var(--text-secondary); margin: 4px 0 8px;">
                        <span><i class="fa-solid fa-book"></i> ${escapeHtml(n.subject || 'General')}</span> &bull;
                        <span>${new Date(n.created_at).toLocaleDateString()}</span>
                    </div>
                    <div style="font-size: 13.5px; color: var(--text-primary); max-height: 120px; overflow-y: auto; white-space: pre-wrap;">${escapeHtml(n.content)}</div>
                </div>
            </div>
        `).join('');
    } catch (err) {
        console.error('[LOAD TEACHER NOTES ERROR]', err);
    }
}

// --- Announcements Broadcaster ---
document.getElementById('ann-publish-btn')?.addEventListener('click', async () => {
    const classId = document.getElementById('ann-target-class-select')?.value;
    const priority = document.getElementById('ann-priority-select')?.value;
    const title = document.getElementById('ann-title-input')?.value?.trim();
    const message = document.getElementById('ann-message-input')?.value?.trim();

    if (!classId || !title || !message) {
        showToast('Class, Title, and Message are required', 'error');
        return;
    }

    try {
        await api.postTeacherAnnouncement(authToken, { classId, priority, title, message });
        showToast('Announcement broadcasted to all students! 📢', 'success');
        document.getElementById('ann-title-input').value = '';
        document.getElementById('ann-message-input').value = '';
        loadTeacherAnnouncementsTab();
    } catch (err) {
        showToast(err.message || 'Failed to post announcement', 'error');
    }
});

async function loadTeacherAnnouncementsTab() {
    const list = document.getElementById('teacher-announcements-list');
    if (!list || !activeTeacherClasses.length) return;
    const classId = selectedTeacherClassId || activeTeacherClasses[0]?.id;

    try {
        const res = await api.getTeacherClassDetails(authToken, classId);
        const announcements = res.stream?.announcements || [];

        if (announcements.length === 0) {
            list.innerHTML = `
                <div class="classroom-empty-state">
                    <i class="fa-solid fa-bullhorn" style="font-size: 32px; color: var(--text-secondary);"></i>
                    <h4 style="margin: 10px 0 4px;">No Announcements Yet</h4>
                    <p>Broadcast your first notice to the class using the form above.</p>
                </div>
            `;
            return;
        }

        list.innerHTML = announcements.map(a => `
            <div class="stream-item-card">
                <div class="stream-item-header">
                    <div class="stream-item-avatar">${(a.teacher_name || 'T').charAt(0).toUpperCase()}</div>
                    <div class="stream-item-meta">
                        <h4>${escapeHtml(a.title)}</h4>
                        <span>Posted by ${escapeHtml(a.teacher_name)} &bull; ${new Date(a.created_at).toLocaleDateString()}</span>
                    </div>
                    <span class="stream-priority-tag ${a.priority || 'normal'}">${(a.priority || 'normal').toUpperCase()}</span>
                </div>
                <div style="font-size: 14px; color: var(--text-primary); white-space: pre-wrap;">${escapeHtml(a.message)}</div>
            </div>
        `).join('');
    } catch (err) {
        console.error('[LOAD ANNOUNCEMENTS ERROR]', err);
    }
}

// --- People Tab & Student Restrictions ---
async function loadTeacherPeopleTab() {
    const teacherList = document.getElementById('teacher-people-teachers-list');
    const studentList = document.getElementById('teacher-people-students-list');
    const countEl = document.getElementById('teacher-enrolled-count');
    if (!teacherList || !studentList || !activeTeacherClasses.length) return;
    const classId = selectedTeacherClassId || activeTeacherClasses[0]?.id;

    try {
        const res = await api.getTeacherClassDetails(authToken, classId);
        const teachers = res.teachers || [];
        const students = res.students || [];

        if (countEl) countEl.textContent = students.length;

        teacherList.innerHTML = teachers.map(t => `
            <div class="person-row">
                <div class="person-info">
                    <div class="person-avatar">${(t.username || 'T').charAt(0).toUpperCase()}</div>
                    <div>
                        <strong style="font-size: 14px; color: var(--text-primary);">${escapeHtml(t.username)}</strong>
                        <div style="font-size: 12px; color: var(--text-secondary);">${escapeHtml(t.subject || 'Faculty')} &bull; ${t.role || 'Teacher'}</div>
                    </div>
                </div>
            </div>
        `).join('');

        if (students.length === 0) {
            studentList.innerHTML = `
                <div style="padding: 24px; text-align: center; color: var(--text-secondary); font-size: 13.5px;">
                    No students currently enrolled in this classroom. Share class code <strong>${res.classroom.class_code}</strong> with students.
                </div>
            `;
        } else {
            studentList.innerHTML = students.map(s => `
                <div class="person-row">
                    <div class="person-info">
                        <div class="person-avatar" style="background: color-mix(in srgb, #16A34A 12%, transparent); color: #059669;">${(s.username || 'S').charAt(0).toUpperCase()}</div>
                        <div>
                            <strong style="font-size: 14px; color: var(--text-primary);">${escapeHtml(s.username)}</strong>
                            <div style="font-size: 12px; color: var(--text-secondary);">Joined: ${new Date(s.joined_at).toLocaleDateString()} &bull; Instant Code</div>
                        </div>
                    </div>
                    <div class="person-actions">
                        <button class="btn-action-remove" onclick="removeStudentFromClass(${classId}, ${s.id})" title="Remove from class (Can rejoin with code)">
                            <i class="fa-solid fa-user-minus"></i> Remove
                        </button>
                        <button class="btn-action-block" onclick="blockStudentFromClass(${classId}, ${s.id})" title="Block student (Cannot rejoin)">
                            <i class="fa-solid fa-ban"></i> Block
                        </button>
                    </div>
                </div>
            `).join('');
        }
    } catch (err) {
        console.error('[LOAD PEOPLE ERROR]', err);
    }
}

window.removeStudentFromClass = async function(classId, studentId) {
    if (!confirm('Remove student from this classroom? They will be able to rejoin if they have the class code.')) return;
    try {
        await api.removeStudentFromClass(authToken, classId, studentId);
        showToast('Student removed from classroom', 'info');
        loadTeacherPeopleTab();
    } catch (err) {
        showToast(err.message || 'Failed to remove student', 'error');
    }
};

window.blockStudentFromClass = async function(classId, studentId) {
    const reason = prompt('Enter reason for blocking student:');
    if (!reason) return;
    try {
        await api.blockStudentFromClass(authToken, classId, studentId, reason);
        showToast('Student has been blocked from classroom', 'info');
        loadTeacherPeopleTab();
    } catch (err) {
        showToast(err.message || 'Failed to block student', 'error');
    }
};

document.getElementById('teacher-regenerate-code-btn')?.addEventListener('click', async () => {
    const classId = selectedTeacherClassId || activeTeacherClasses[0]?.id;
    if (!classId) return;
    if (!confirm('Regenerate class code? Previous code will expire for new students.')) return;
    try {
        const res = await api.regenerateClassCode(authToken, classId);
        showToast(`New Class Code generated: ${res.newCode} 🔑`, 'success');
        loadTeacherPortal();
    } catch (err) {
        showToast(err.message || 'Failed to regenerate code', 'error');
    }
});


// ============================================================================
// STUDENT HUB CLASSROOM CONTROLLER
// ============================================================================
async function loadStudentClassrooms() {
    if (!authToken) return;
    const grid = document.getElementById('student-enrolled-classes-grid');
    const emptyState = document.getElementById('student-no-classes-empty');
    if (!grid) return;

    try {
        const res = await api.getStudentEnrolledClasses(authToken);
        const classes = res.classes || [];

        if (classes.length === 0) {
            grid.innerHTML = '';
            if (emptyState) emptyState.style.display = 'block';
            return;
        }

        if (emptyState) emptyState.style.display = 'none';

        grid.innerHTML = classes.map(c => `
            <div class="class-card" onclick="openStudentClassDetail(${c.id})">
                <div class="class-card-header">
                    <h3 class="class-card-title">${escapeHtml(c.name)} - Section ${escapeHtml(c.section)}</h3>
                    <div class="class-card-sub">${escapeHtml(c.subject || 'All Subjects')} &bull; ${escapeHtml(c.academic_year || '2026-27')}</div>
                    <div class="class-card-code-pill">
                        <i class="fa-solid fa-key"></i> Code: ${c.class_code}
                    </div>
                </div>
                <div class="class-card-body">
                    <div class="class-card-meta-row">
                        <span><i class="fa-solid fa-chalkboard-user"></i> Teachers</span>
                        <strong>${(c.teachers || []).map(t => t.username).join(', ') || 'Faculty'}</strong>
                    </div>
                    <div class="class-card-meta-row">
                        <span><i class="fa-solid fa-book-open"></i> Homework</span>
                        <strong>${c.homework_count || 0} Assigned</strong>
                    </div>
                    <div class="class-card-meta-row">
                        <span><i class="fa-solid fa-file-signature"></i> AI Worksheets</span>
                        <strong>${c.worksheet_count || 0} Available</strong>
                    </div>
                </div>
                <div class="class-card-footer">
                    <span style="font-size: 12.5px; font-weight: 700; color: #2563EB;">Open Class Stream &bull; Classwork <i class="fa-solid fa-arrow-right"></i></span>
                </div>
            </div>
        `).join('');
    } catch (err) {
        console.error('[LOAD STUDENT CLASSES ERROR]', err);
    }
}

// Student Join Class Modal Handlers
function openStudentJoinModal() {
    const modal = document.getElementById('join-class-modal');
    if (modal) modal.style.display = 'flex';
}
function closeStudentJoinModal() {
    const modal = document.getElementById('join-class-modal');
    if (modal) modal.style.display = 'none';
}
document.getElementById('student-open-join-modal-btn')?.addEventListener('click', openStudentJoinModal);
document.getElementById('student-empty-join-btn')?.addEventListener('click', openStudentJoinModal);
document.getElementById('close-join-class-modal-btn')?.addEventListener('click', closeStudentJoinModal);

document.getElementById('student-submit-join-class-btn')?.addEventListener('click', async () => {
    const input = document.getElementById('student-join-class-code-input');
    const classCode = input?.value?.trim();

    if (!classCode) {
        showToast('Please enter a 6-character class code', 'error');
        return;
    }

    try {
        const res = await api.studentJoinClass(authToken, classCode);
        showToast(res.message || 'Joined classroom successfully! 🎉', 'success');
        closeStudentJoinModal();
        if (input) input.value = '';
        loadStudentClassrooms();
    } catch (err) {
        showToast(err.message || 'Failed to join class', 'error');
    }
});

// Student Class Detail View
async function openStudentClassDetail(classId) {
    currentStudentClassId = classId;
    const listView = document.getElementById('student-classes-list-view');
    const detailView = document.getElementById('student-class-detail-view');
    if (listView) listView.style.display = 'none';
    if (detailView) detailView.style.display = 'block';

    try {
        const [detailsRes, feedRes] = await Promise.all([
            api.getStudentClassDetails(authToken, classId),
            api.getStudentClassFeed(authToken, classId)
        ]);

        const cls = detailsRes.classroom;
        const teachers = detailsRes.teachers || [];
        const classmates = detailsRes.classmates || [];
        const stream = feedRes.stream || {};

        // Update Hero
        document.getElementById('student-class-hero-title').textContent = `${cls.name} - Section ${cls.section}`;
        document.getElementById('student-class-hero-sub').textContent = `${cls.subject || 'All Subjects'} • Academic Year ${cls.academic_year || '2026-27'}`;
        document.getElementById('student-view-class-code').textContent = cls.class_code;

        document.getElementById('student-class-hero-teachers').innerHTML = teachers.map(t => `
            <span class="class-teacher-badge"><i class="fa-solid fa-chalkboard-user"></i> ${escapeHtml(t.username)} (${escapeHtml(t.subject || 'Teacher')})</span>
        `).join('');

        // Render Stream Feed
        renderStudentStreamFeed(stream);

        // Render Homework Pane
        renderStudentHomeworkPane(stream.homework || []);

        // Render Worksheets Pane
        renderStudentWorksheetsPane(stream.worksheets || []);

        // Render Notes Pane
        renderStudentNotesPane(stream.notes || []);

        // Render People Pane
        renderStudentPeoplePane(teachers, classmates);

        // Default to stream tab
        switchStudentClassTab('stream');
    } catch (err) {
        console.error('[OPEN STUDENT CLASS DETAIL ERROR]', err);
    }
}

document.getElementById('student-back-to-classes-btn')?.addEventListener('click', () => {
    document.getElementById('student-class-detail-view').style.display = 'none';
    document.getElementById('student-classes-list-view').style.display = 'block';
    loadStudentClassrooms();
});

document.getElementById('student-copy-class-code-btn')?.addEventListener('click', () => {
    const code = document.getElementById('student-view-class-code')?.textContent;
    if (code) copyTextToClipboard(code, 'Class code copied to clipboard!');
});

// Student Class Navigation Tabs
document.querySelectorAll('.class-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-student-tab');
        switchStudentClassTab(tab);
    });
});

function switchStudentClassTab(tabName) {
    document.querySelectorAll('.class-tab-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-student-tab') === tabName);
    });
    document.querySelectorAll('.student-class-pane').forEach(p => {
        p.classList.remove('active');
        p.style.display = 'none';
    });
    const target = document.getElementById(`student-pane-${tabName}`);
    if (target) {
        target.classList.add('active');
        target.style.display = 'block';
    }
}

function renderStudentStreamFeed(stream) {
    const feedList = document.getElementById('student-stream-feed-list');
    const upcomingList = document.getElementById('student-stream-upcoming-list');
    if (!feedList) return;

    const announcements = (stream.announcements || []).map(a => ({ ...a, feedType: 'announcement' }));
    const homework = (stream.homework || []).map(h => ({ ...h, feedType: 'homework' }));
    const worksheets = (stream.worksheets || []).map(w => ({ ...w, feedType: 'worksheet' }));
    const notes = (stream.notes || []).map(n => ({ ...n, feedType: 'note' }));

    const allFeed = [...announcements, ...homework, ...worksheets, ...notes].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    if (allFeed.length === 0) {
        feedList.innerHTML = `
            <div class="stream-item-card" style="text-align: center; padding: 40px 20px;">
                <i class="fa-solid fa-comments" style="font-size: 32px; color: var(--text-secondary);"></i>
                <h4 style="margin: 12px 0 4px;">Welcome to your classroom stream!</h4>
                <p style="color: var(--text-secondary); font-size: 13.5px;">This is where you'll see announcements, homework, AI worksheets, and notes from your teachers.</p>
            </div>
        `;
        return;
    }

    feedList.innerHTML = allFeed.map(item => {
        if (item.feedType === 'announcement') {
            return `
                <div class="stream-item-card">
                    <div class="stream-item-header">
                        <div class="stream-item-avatar"><i class="fa-solid fa-bullhorn"></i></div>
                        <div class="stream-item-meta">
                            <h4>${escapeHtml(item.title)}</h4>
                            <span>Posted by ${escapeHtml(item.teacher_name)} &bull; ${new Date(item.created_at).toLocaleDateString()}</span>
                        </div>
                        <span class="stream-priority-tag ${item.priority || 'normal'}">${(item.priority || 'normal').toUpperCase()}</span>
                    </div>
                    <div style="font-size: 14px; color: var(--text-primary); white-space: pre-wrap;">${escapeHtml(item.message)}</div>
                </div>
            `;
        } else if (item.feedType === 'homework') {
            return `
                <div class="stream-item-card" style="border-left: 4px solid #2563EB;">
                    <div class="stream-item-header">
                        <div class="stream-item-avatar"><i class="fa-solid fa-book-open"></i></div>
                        <div class="stream-item-meta">
                            <h4>New Homework: ${escapeHtml(item.title)}</h4>
                            <span>Assigned by ${escapeHtml(item.teacher_name)} &bull; Due: ${item.due_date || 'Soon'}</span>
                        </div>
                        <span class="status-pill-${item.my_submission_status || 'assigned'}">${(item.my_submission_status || 'Assigned').toUpperCase()}</span>
                    </div>
                    <p style="font-size: 13.5px; color: var(--text-secondary); margin: 6px 0 10px;">${escapeHtml(item.instructions || '')}</p>
                    <button class="btn btn-primary" onclick="switchStudentClassTab('homework')" style="font-size: 13px; padding: 7px 14px;">
                        View Homework &amp; Submit
                    </button>
                </div>
            `;
        } else if (item.feedType === 'worksheet') {
            return `
                <div class="stream-item-card" style="border-left: 4px solid #7C3AED;">
                    <div class="stream-item-header">
                        <div class="stream-item-avatar" style="background: color-mix(in srgb, #7C3AED 12%, transparent); color: #7C3AED;"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
                        <div class="stream-item-meta">
                            <h4>AI Practice Worksheet: ${escapeHtml(item.title)}</h4>
                            <span>${item.total_marks || 20} Marks &bull; ${item.duration || 20} Mins</span>
                        </div>
                        ${item.my_best_score !== null && item.my_best_score !== undefined ? `<span class="status-pill-graded">Best Score: ${item.my_best_score}/${item.total_marks || 20}</span>` : ''}
                    </div>
                    <button class="btn btn-primary" onclick="startStudentWorksheet(${item.id})" style="font-size: 13px; padding: 7px 14px; background: #7C3AED;">
                        <i class="fa-solid fa-play"></i> Start Worksheet Assessment
                    </button>
                </div>
            `;
        } else {
            return `
                <div class="stream-item-card" style="border-left: 4px solid #059669;">
                    <div class="stream-item-header">
                        <div class="stream-item-avatar" style="background: color-mix(in srgb, #16A34A 12%, transparent); color: #059669;"><i class="fa-solid fa-file-lines"></i></div>
                        <div class="stream-item-meta">
                            <h4>Study Note: ${escapeHtml(item.title)}</h4>
                            <span>Subject: ${escapeHtml(item.subject || 'General')}</span>
                        </div>
                    </div>
                    <div style="font-size: 13.5px; color: var(--text-primary); max-height: 100px; overflow-y: auto; white-space: pre-wrap;">${escapeHtml(item.content)}</div>
                </div>
            `;
        }
    }).join('');
}

function renderStudentHomeworkPane(homeworkList) {
    const list = document.getElementById('student-homework-cards-list');
    const countEl = document.getElementById('student-hw-count');
    if (!list) return;

    if (countEl) countEl.textContent = `${homeworkList.length} Assignments`;

    if (homeworkList.length === 0) {
        list.innerHTML = `
            <div class="classroom-empty-state">
                <i class="fa-solid fa-check-circle" style="font-size: 32px; color: #10B981;"></i>
                <h4 style="margin: 10px 0 4px;">All Caught Up!</h4>
                <p>No homework currently assigned for this class.</p>
            </div>
        `;
        return;
    }

    list.innerHTML = homeworkList.map(h => `
        <div class="hw-card">
            <div style="flex: 1;">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <h3 style="margin: 0; font-size: 16px; font-weight: 800; color: var(--text-primary);">${escapeHtml(h.title)}</h3>
                    <span class="status-pill-${h.submission_status || 'assigned'}">${(h.submission_status || 'Assigned').toUpperCase()}</span>
                </div>
                <div style="font-size: 12.5px; color: var(--text-secondary); margin: 4px 0 8px;">
                    <span><i class="fa-solid fa-book"></i> ${escapeHtml(h.subject)}</span> &bull; 
                    <span><i class="fa-solid fa-star"></i> ${h.max_marks || 100} Marks</span> &bull;
                    <span class="hw-due-pill"><i class="fa-solid fa-clock"></i> Due: ${h.due_date || 'No deadline'}</span>
                </div>
                <p style="font-size: 13.5px; color: var(--text-primary); white-space: pre-wrap;">${escapeHtml(h.instructions || '')}</p>

                ${h.marks !== null && h.marks !== undefined ? `
                    <div style="margin-top: 10px; padding: 10px 14px; background: color-mix(in srgb, #16A34A 12%, transparent); border-radius: 10px; border: 1px solid #A7F3D0;">
                        <strong style="color: #065F46;">Grade: ${h.marks} / ${h.max_marks || 100} Marks</strong>
                        <p style="margin: 4px 0 0; font-size: 13px; color: #047857;">Teacher Feedback: ${escapeHtml(h.feedback || 'Great job!')}</p>
                    </div>
                ` : ''}
            </div>

            <div>
                <button class="btn btn-primary" onclick="openStudentSubmitHomeworkModal(${h.id}, '${escapeHtml(h.title)}')" style="font-size: 13px; padding: 9px 16px;">
                    <i class="fa-solid fa-arrow-up-from-bracket"></i> ${h.submission_status === 'submitted' || h.submission_status === 'graded' ? 'Update Submission' : 'Turn In Work'}
                </button>
            </div>
        </div>
    `).join('');
}

window.openStudentSubmitHomeworkModal = function(homeworkId, title) {
    const answer = prompt(`Enter your homework submission text/solution for: "${title}"`);
    if (!answer) return;
    api.submitStudentHomework(authToken, homeworkId, answer, [])
        .then(res => {
            showToast(res.message || 'Homework turned in successfully! +30 XP earned! 🚀', 'success');
            openStudentClassDetail(currentStudentClassId);
        })
        .catch(err => showToast(err.message || 'Failed to submit homework', 'error'));
};

function renderStudentWorksheetsPane(worksheets) {
    const grid = document.getElementById('student-worksheets-cards-grid');
    const countEl = document.getElementById('student-ws-count');
    if (!grid) return;

    if (countEl) countEl.textContent = `${worksheets.length} Worksheets`;

    if (worksheets.length === 0) {
        grid.innerHTML = `
            <div class="classroom-empty-state" style="grid-column: 1 / -1;">
                <i class="fa-solid fa-file-signature" style="font-size: 32px; color: var(--text-secondary);"></i>
                <h4 style="margin: 10px 0 4px;">No AI Worksheets Yet</h4>
                <p>When your teacher publishes practice worksheets, they will appear here.</p>
            </div>
        `;
        return;
    }

    grid.innerHTML = worksheets.map(w => `
        <div class="ws-card">
            <div>
                <h3 style="margin: 0; font-size: 16px; font-weight: 800; color: var(--text-primary);">${escapeHtml(w.title)}</h3>
                <div style="font-size: 12.5px; color: var(--text-secondary); margin: 4px 0 8px;">
                    <span><i class="fa-solid fa-book"></i> ${escapeHtml(w.subject)}</span> &bull; 
                    <span><i class="fa-solid fa-star"></i> ${w.total_marks || 20} Marks</span> &bull;
                    <span><i class="fa-solid fa-stopwatch"></i> ${w.duration || 20} Mins</span>
                </div>
                ${w.my_score !== null && w.my_score !== undefined ? `
                    <span class="status-pill-graded"><i class="fa-solid fa-check-double"></i> Best Attempt: ${w.my_score} / ${w.total_marks || 20} Marks</span>
                ` : '<span class="status-pill-assigned">Not Attempted Yet</span>'}
            </div>
            <div>
                <button class="btn btn-primary" onclick="startStudentWorksheet(${w.id})" style="font-size: 13.5px; padding: 10px 20px;">
                    <i class="fa-solid fa-play"></i> ${w.my_score !== null && w.my_score !== undefined ? 'Retake Worksheet' : 'Start Worksheet'}
                </button>
            </div>
        </div>
    `).join('');
}

window.startStudentWorksheet = async function(worksheetId) {
    try {
        const res = await api.getStudentClassFeed(authToken, currentStudentClassId);
        const ws = (res.stream?.worksheets || []).find(w => w.id === worksheetId);
        if (!ws) {
            showToast('Worksheet not found', 'error');
            return;
        }

        let parsed = {};
        try {
            parsed = JSON.parse(ws.worksheet_data);
        } catch {
            parsed = { questions: [] };
        }

        openWorksheetPlayerModal(ws, parsed);
    } catch (err) {
        showToast(err.message || 'Failed to start worksheet', 'error');
    }
};

function openWorksheetPlayerModal(worksheet, worksheetData) {
    const modal = document.getElementById('worksheet-player-modal');
    if (!modal) return;

    document.getElementById('player-ws-title').textContent = worksheet.title;
    document.getElementById('player-ws-meta').textContent = `${worksheet.subject} • Total Marks: ${worksheet.total_marks || 20}`;

    const container = document.getElementById('player-questions-container');
    const questions = worksheetData.questions || [];

    container.innerHTML = questions.map((q, idx) => `
        <div style="margin-bottom: 20px; padding: 16px; background: var(--surface-inset); border-radius: 14px; border: 1.5px solid var(--border-color);">
            <div style="font-weight: 800; font-size: 14.5px; color: var(--text-primary); margin-bottom: 10px;">
                ${idx + 1}. ${escapeHtml(q.question)} <span style="font-size: 12px; color: var(--text-secondary);">(${q.marks || 1} mark)</span>
            </div>
            ${q.options && q.options.length ? `
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    ${q.options.map((opt, optIdx) => `
                        <label style="display: flex; align-items: center; gap: 8px; font-size: 13.5px; cursor: pointer; padding: 8px 12px; background: var(--surface); border: 1px solid var(--border-color); border-radius: 8px;">
                            <input type="radio" name="ws_q_${q.id}" value="${escapeHtml(opt)}">
                            <span>${escapeHtml(opt)}</span>
                        </label>
                    `).join('')}
                </div>
            ` : `
                <textarea class="form-control" name="ws_q_${q.id}" rows="3" placeholder="Type your answer here..."></textarea>
            `}
        </div>
    `).join('');

    modal.style.display = 'flex';

    // Start Timer
    let durationMins = worksheet.duration_minutes || worksheet.duration || (worksheetData && worksheetData.duration_minutes) || 20;
    let durationSecs = durationMins * 60;
    clearInterval(activeWorksheetTimer);
    activeWorksheetTimer = setInterval(() => {
        durationSecs--;
        const mins = Math.floor(durationSecs / 60);
        const secs = durationSecs % 60;
        const timerEl = document.getElementById('player-time-left');
        if (timerEl) timerEl.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
        if (durationSecs <= 0) {
            clearInterval(activeWorksheetTimer);
            document.getElementById('player-submit-worksheet-btn')?.click();
        }
    }, 1000);

    document.getElementById('player-submit-worksheet-btn').onclick = async () => {
        clearInterval(activeWorksheetTimer);
        const answers = [];
        questions.forEach(q => {
            if (q.options && q.options.length) {
                const checked = container.querySelector(`input[name="ws_q_${q.id}"]:checked`);
                answers.push({ id: q.id, answer: checked ? checked.value : '' });
            } else {
                const textarea = container.querySelector(`textarea[name="ws_q_${q.id}"]`);
                answers.push({ id: q.id, answer: textarea ? textarea.value : '' });
            }
        });

        const submitBtn = document.getElementById('player-submit-worksheet-btn');
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Marking your answers…';

        try {
            const result = await api.submitStudentWorksheet(authToken, worksheet.id, answers);
            showToast(result.message || `Worksheet submitted! Score: ${result.score}/${result.totalPossible}`, 'success');
            // Show the marked paper rather than closing on a bare score.
            renderWorksheetResult({
                title: worksheet.title,
                score: result.score,
                totalPossible: result.totalPossible,
                xpEarned: result.xpEarned,
                results: result.results || []
            });
        } catch (err) {
            showToast(err.message || 'Failed to submit worksheet', 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fa-solid fa-check"></i> Submit Assessment';
        }
    };
}
document.getElementById('close-player-modal-btn')?.addEventListener('click', () => {
    clearInterval(activeWorksheetTimer);
    document.getElementById('worksheet-player-modal').style.display = 'none';
});

function renderStudentNotesPane(notes) {
    const grid = document.getElementById('student-notes-cards-grid');
    if (!grid) return;

    if (notes.length === 0) {
        grid.innerHTML = `
            <div class="classroom-empty-state" style="grid-column: 1 / -1;">
                <i class="fa-solid fa-notes-medical" style="font-size: 32px; color: var(--text-secondary);"></i>
                <h4 style="margin: 10px 0 4px;">No Notes Shared Yet</h4>
                <p>Lecture materials and formulas shared by your teacher will appear here.</p>
            </div>
        `;
        return;
    }

    grid.innerHTML = notes.map(n => `
        <div class="note-card">
            <div>
                <h3 style="margin: 0; font-size: 16px; font-weight: 800; color: var(--text-primary);">${escapeHtml(n.title)}</h3>
                <div style="font-size: 12.5px; color: var(--text-secondary); margin: 4px 0 8px;">
                    <span><i class="fa-solid fa-book"></i> ${escapeHtml(n.subject || 'General')}</span> &bull;
                    <span>Shared by ${escapeHtml(n.teacher_name || 'Teacher')}</span>
                </div>
                <div style="font-size: 13.5px; color: var(--text-primary); white-space: pre-wrap; line-height: 1.5;">${escapeHtml(n.content)}</div>
            </div>
        </div>
    `).join('');
}

function renderStudentPeoplePane(teachers, classmates) {
    const teacherList = document.getElementById('student-people-teachers-list');
    const classmateList = document.getElementById('student-people-classmates-list');
    if (!teacherList || !classmateList) return;

    teacherList.innerHTML = teachers.map(t => `
        <div class="person-row">
            <div class="person-info">
                <div class="person-avatar">${(t.username || 'T').charAt(0).toUpperCase()}</div>
                <div>
                    <strong style="font-size: 14px; color: var(--text-primary);">${escapeHtml(t.username)}</strong>
                    <div style="font-size: 12px; color: var(--text-secondary);">${escapeHtml(t.subject || 'Teacher')} &bull; Faculty</div>
                </div>
            </div>
        </div>
    `).join('');

    classmateList.innerHTML = classmates.map(c => `
        <div class="person-row">
            <div class="person-info">
                <div class="person-avatar" style="background: color-mix(in srgb, #2563EB 12%, transparent); color: #2563EB;">${(c.username || 'S').charAt(0).toUpperCase()}</div>
                <div>
                    <strong style="font-size: 14px; color: var(--text-primary);">${escapeHtml(c.username)}</strong>
                    <div style="font-size: 12px; color: var(--text-secondary);">Student &bull; Classmate</div>
                </div>
            </div>
        </div>
    `).join('');
}

// Global Helper: Copy text to clipboard
function copyTextToClipboard(text, msg) {
    navigator.clipboard.writeText(text).then(() => {
        showToast(msg || 'Copied to clipboard! 📋', 'success');
    }).catch(() => {
        showToast(`Code: ${text}`, 'info');
    });
}



// ═══════════════════════════════════════════════════════════════════
//  STREAK FREEZE
// ═══════════════════════════════════════════════════════════════════

async function refreshStreakFreezeUI() {
    const btn = document.getElementById('dash-streak-freeze-btn');
    const pill = document.getElementById('dash-streak-pill');
    if (!btn || !authToken) return;
    try {
        const { streak, streak_freezes } = await api.getStreak(authToken);
        const studiedToday = (currentUserData && currentUserData.studied_today) ? currentUserData.studied_today > 0 : false;
        const countEl = document.getElementById('dash-freeze-count');
        if (countEl) countEl.textContent = streak_freezes;

        // Only offer a freeze when the user has one, has an active streak worth protecting,
        // and hasn't already studied today.
        if (streak_freezes > 0 && streak > 0 && !studiedToday) {
            btn.style.display = 'inline-flex';
        } else {
            btn.style.display = 'none';
        }
        if (pill) {
            pill.innerHTML = streak > 0
                ? `<i class="fa-solid fa-fire"></i> ${streak === 1 ? "Great start — keep it going!" : "On a roll!"}`
                : `<i class="fa-solid fa-seedling"></i> Start today's streak`;
        }
    } catch (e) { /* streak endpoint optional — fail quietly */ }
}

document.getElementById('dash-streak-freeze-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
        const res = await api.useStreakFreeze(authToken);
        showToast(`🧊 ${res.message}`, 'success');
        if (currentUserData) currentUserData.streak = res.streak;
        updateDashboardUI();
    } catch (err) {
        showToast(err.message || "Couldn't use a freeze right now.", 'error');
    } finally {
        btn.disabled = false;
    }
});

// ═══════════════════════════════════════════════════════════════════
//  ACHIEVEMENT BADGES
// ═══════════════════════════════════════════════════════════════════

async function loadBadges() {
    const grid = document.getElementById('badge-grid');
    const progressLabel = document.getElementById('badges-progress-label');
    if (!grid || !authToken) return;
    grid.innerHTML = `<div style="grid-column: 1/-1; text-align:center; padding: 20px; color: var(--text-secondary);"><i class="fa-solid fa-spinner fa-spin"></i> Loading your badges...</div>`;
    try {
        const { badges, earnedCount, totalCount } = await api.getBadges(authToken);
        if (progressLabel) progressLabel.textContent = `${earnedCount} / ${totalCount} earned`;

        grid.innerHTML = badges.map(b => `
            <div class="badge-tile ${b.earned ? 'badge-earned' : 'badge-locked'}" title="${escapeHtml(b.description)}">
                <div class="badge-icon"><i class="${b.icon}"></i></div>
                <div class="badge-label">${escapeHtml(b.label)}</div>
                <div class="badge-desc">${escapeHtml(b.description)}</div>
                ${b.earned ? '<div class="badge-check"><i class="fa-solid fa-circle-check"></i></div>' : '<div class="badge-check badge-check-locked"><i class="fa-solid fa-lock"></i></div>'}
            </div>
        `).join('');
    } catch (e) {
        grid.innerHTML = `<div style="grid-column: 1/-1; text-align:center; padding: 20px; color: var(--text-secondary);">Couldn't load badges right now — try again shortly.</div>`;
    }
}

// ═══════════════════════════════════════════════════════════════════
//  FLASHCARDS (Spaced Repetition, SM-2)
// ═══════════════════════════════════════════════════════════════════

let fcReviewQueue = [];
let fcReviewIndex = 0;
let fcReviewSourceLabel = '';

async function loadFlashcardDecks() {
    const grid = document.getElementById('fc-deck-grid');
    if (!grid || !authToken) return;
    grid.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:20px; color: var(--text-secondary);"><i class="fa-solid fa-spinner fa-spin"></i> Loading your decks...</div>`;

    try {
        const [{ decks }, { cards: dueCards }] = await Promise.all([
            api.getFlashcardDecks(authToken),
            api.getDueFlashcards(authToken)
        ]);

        const dueLabel = document.getElementById('fc-due-count-label');
        const startBtn = document.getElementById('fc-start-review-btn');
        if (dueLabel) {
            dueLabel.textContent = dueCards.length > 0
                ? `${dueCards.length} card${dueCards.length === 1 ? '' : 's'} ready for review`
                : "You're all caught up! 🎉";
        }
        if (startBtn) startBtn.disabled = dueCards.length === 0;
        startBtn.onclick = () => startFlashcardReview(dueCards, 'All Decks');

        if (!decks.length) {
            grid.innerHTML = `
                <div class="empty-state-card" style="grid-column:1/-1;">
                    <i class="fa-solid fa-layer-group" style="font-size: 32px; color: var(--accent-primary); opacity: 0.5;"></i>
                    <p style="margin-top: 12px; color: var(--text-secondary);">No decks yet — paste some notes above and generate your first one. You've got this!</p>
                </div>
            `;
            return;
        }

        grid.innerHTML = decks.map(d => `
            <div class="fc-deck-card" data-deck-id="${d.id}">
                <div class="fc-deck-card-top">
                    <div class="fc-deck-icon"><i class="fa-solid fa-layer-group"></i></div>
                    ${d.due_count > 0 ? `<span class="fc-deck-due-badge">${d.due_count} due</span>` : ''}
                </div>
                <h4>${escapeHtml(d.title)}</h4>
                <p>${d.card_count} card${d.card_count === 1 ? '' : 's'}</p>
                <div class="fc-deck-card-actions">
                    <button class="tool-act-btn fc-study-deck-btn" data-deck-id="${d.id}"><i class="fa-solid fa-play"></i> Study</button>
                    <button class="tool-act-btn fc-delete-deck-btn" data-deck-id="${d.id}" title="Delete deck"><i class="fa-regular fa-trash-can"></i></button>
                </div>
            </div>
        `).join('');

        grid.querySelectorAll('.fc-study-deck-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const deckId = btn.getAttribute('data-deck-id');
                const { deck, cards } = await api.getFlashcardDeck(authToken, deckId);
                if (!cards.length) { showToast('This deck has no cards yet.', 'info'); return; }
                startFlashcardReview(cards, deck.title);
            });
        });

        grid.querySelectorAll('.fc-delete-deck-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm('Delete this deck? This cannot be undone.')) return;
                await api.deleteFlashcardDeck(authToken, btn.getAttribute('data-deck-id'));
                showToast('Deck deleted', 'info');
                loadFlashcardDecks();
            });
        });
    } catch (e) {
        grid.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:20px; color: var(--text-secondary);">Couldn't load your decks — please try again.</div>`;
    }
}

document.getElementById('fc-generate-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('fc-generate-btn');
    const status = document.getElementById('fc-generate-status');
    const source = document.getElementById('fc-gen-source').value.trim();
    const title = document.getElementById('fc-gen-title').value.trim();
    const count = document.getElementById('fc-gen-count').value;

    if (source.length < 20) {
        showToast('Add a bit more detail — a few sentences of notes or a clear topic works great.', 'info');
        return;
    }

    btn.disabled = true;
    status.style.display = 'block';
    try {
        const res = await api.generateFlashcards(authToken, source, title, count);
        showToast(`✨ Created ${res.cards.length} flashcards! Nicely done.`, 'success');
        document.getElementById('fc-gen-source').value = '';
        document.getElementById('fc-gen-title').value = '';
        await api.addXp(authToken, 15, 5, 'Flashcard Generation').then(r => applyXpResult(r));
        loadFlashcardDecks();
    } catch (err) {
        showToast(err.message || "Couldn't generate flashcards — please try again.", 'error');
    } finally {
        btn.disabled = false;
        status.style.display = 'none';
    }
});

function startFlashcardReview(cards, sourceLabel) {
    if (!cards || !cards.length) return;
    fcReviewQueue = [...cards];
    fcReviewIndex = 0;
    fcReviewSourceLabel = sourceLabel;
    document.getElementById('fc-review-overlay').style.display = 'flex';
    showFlashcardAt(0);
}

function showFlashcardAt(idx) {
    const card = fcReviewQueue[idx];
    const flipCard = document.getElementById('fc-flip-card');
    const gradeRow = document.getElementById('fc-grade-row');
    if (!card) { closeFlashcardReview(); return; }

    flipCard.classList.remove('flipped');
    gradeRow.style.display = 'none';
    document.getElementById('fc-review-question').textContent = card.question;
    document.getElementById('fc-review-answer').textContent = card.answer;
    document.getElementById('fc-review-progress-text').textContent = `${idx + 1} / ${fcReviewQueue.length}`;
}

document.getElementById('fc-flip-card')?.addEventListener('click', function () {
    const isFlipped = this.classList.toggle('flipped');
    document.getElementById('fc-grade-row').style.display = isFlipped ? 'flex' : 'none';
});

document.getElementById('fc-review-close')?.addEventListener('click', closeFlashcardReview);

function closeFlashcardReview() {
    document.getElementById('fc-review-overlay').style.display = 'none';
    fcReviewQueue = [];
    fcReviewIndex = 0;
    loadFlashcardDecks();
}

document.querySelectorAll('.fc-grade-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
        const quality = parseInt(btn.getAttribute('data-quality'), 10);
        const card = fcReviewQueue[fcReviewIndex];
        try {
            await api.reviewFlashcard(authToken, card.id, quality);
        } catch (e) { /* non-fatal — keep the session moving */ }

        // "Again" cards get re-queued near the end so they're practiced once more this session
        if (quality < 3) {
            fcReviewQueue.push(card);
        }

        fcReviewIndex++;
        if (fcReviewIndex >= fcReviewQueue.length) {
            showToast("Review session complete — great focus! 🎉", 'success');
            api.addXp(authToken, 10, 8, 'Flashcard Review').then(r => applyXpResult(r));
            closeFlashcardReview();
        } else {
            showFlashcardAt(fcReviewIndex);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════
//  AI QUIZ GENERATOR
// ═══════════════════════════════════════════════════════════════════

let qzQuestions = [];
let qzAnswers = [];
let qzCurrentIndex = 0;
let qzTopic = '';

function resetQuizUI() {
    document.getElementById('qz-setup-box').style.display = 'block';
    document.getElementById('qz-quiz-box').style.display = 'none';
    document.getElementById('qz-results-box').style.display = 'none';
    document.getElementById('qz-review-list').style.display = 'none';
}

document.getElementById('qz-generate-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('qz-generate-btn');
    const status = document.getElementById('qz-generate-status');
    const topic = document.getElementById('qz-topic').value.trim();
    const sourceText = document.getElementById('qz-source').value.trim();
    const count = document.getElementById('qz-count').value;
    const difficulty = document.getElementById('qz-difficulty').value;

    if (!topic && sourceText.length < 20) {
        showToast('Give me a topic, or paste a bit more source text to build the quiz from.', 'info');
        return;
    }

    btn.disabled = true;
    status.style.display = 'block';
    try {
        const res = await api.generateQuiz(authToken, { topic, sourceText, count, difficulty });
        qzQuestions = res.questions;
        qzAnswers = new Array(qzQuestions.length).fill(null);
        qzCurrentIndex = 0;
        qzTopic = res.topic;

        document.getElementById('qz-setup-box').style.display = 'none';
        document.getElementById('qz-quiz-box').style.display = 'block';
        renderQuizQuestion();
    } catch (err) {
        showToast(err.message || "Couldn't generate the quiz — please try again.", 'error');
    } finally {
        btn.disabled = false;
        status.style.display = 'none';
    }
});

function renderQuizQuestion() {
    const q = qzQuestions[qzCurrentIndex];
    document.getElementById('qz-progress-label').textContent = `Question ${qzCurrentIndex + 1} of ${qzQuestions.length}`;
    document.getElementById('qz-progress-fill').style.width = `${((qzCurrentIndex) / qzQuestions.length) * 100}%`;
    document.getElementById('qz-question-text').textContent = q.question;

    const optionsEl = document.getElementById('qz-options');
    optionsEl.innerHTML = q.options.map((opt, i) => `
        <button class="qz-option-btn" data-index="${i}">
            <span class="qz-option-letter">${String.fromCharCode(65 + i)}</span>
            <span>${escapeHtml(opt)}</span>
        </button>
    `).join('');

    document.getElementById('qz-feedback').style.display = 'none';
    document.getElementById('qz-next-btn').style.display = 'none';

    optionsEl.querySelectorAll('.qz-option-btn').forEach(btn => {
        btn.addEventListener('click', () => selectQuizAnswer(parseInt(btn.getAttribute('data-index'), 10)));
    });
}

function selectQuizAnswer(selectedIndex) {
    const q = qzQuestions[qzCurrentIndex];
    qzAnswers[qzCurrentIndex] = selectedIndex;
    const isCorrect = selectedIndex === q.correctIndex;

    const optionsEl = document.getElementById('qz-options');
    optionsEl.querySelectorAll('.qz-option-btn').forEach((btn, i) => {
        btn.disabled = true;
        if (i === q.correctIndex) btn.classList.add('qz-option-correct');
        else if (i === selectedIndex) btn.classList.add('qz-option-wrong');
    });

    const feedback = document.getElementById('qz-feedback');
    feedback.style.display = 'block';
    feedback.className = isCorrect ? 'qz-feedback-correct' : 'qz-feedback-wrong';
    feedback.innerHTML = isCorrect
        ? `<i class="fa-solid fa-circle-check"></i> Nice one — that's correct! ${escapeHtml(q.explanation || '')}`
        : `<i class="fa-solid fa-circle-info"></i> Not quite, but great try. ${escapeHtml(q.explanation || '')}`;

    document.getElementById('qz-next-btn').style.display = 'block';
    document.getElementById('qz-next-btn').textContent = qzCurrentIndex < qzQuestions.length - 1 ? 'Next Question →' : 'See Results →';
}

document.getElementById('qz-next-btn')?.addEventListener('click', async () => {
    qzCurrentIndex++;
    if (qzCurrentIndex >= qzQuestions.length) {
        await finishQuiz();
    } else {
        renderQuizQuestion();
    }
});

async function finishQuiz() {
    document.getElementById('qz-quiz-box').style.display = 'none';
    document.getElementById('qz-results-box').style.display = 'block';

    try {
        const res = await api.submitQuiz(authToken, qzTopic, qzQuestions, qzAnswers);
        const pct = Math.round((res.score / res.total) * 100);

        document.getElementById('qz-score-text').textContent = `${res.score}/${res.total}`;
        const ring = document.getElementById('qz-score-ring');
        ring.style.setProperty('--qz-pct', `${pct}%`);
        ring.className = 'qz-score-ring ' + (pct >= 80 ? 'qz-ring-great' : pct >= 50 ? 'qz-ring-good' : 'qz-ring-keep-going');

        const title = document.getElementById('qz-results-title');
        const sub = document.getElementById('qz-results-sub');
        if (pct >= 80) {
            title.textContent = "Excellent work! 🌟";
            sub.textContent = `You nailed ${res.score} out of ${res.total} — that's real mastery showing.`;
        } else if (pct >= 50) {
            title.textContent = "Solid effort! 💪";
            sub.textContent = `${res.score} out of ${res.total} — you're building real understanding here.`;
        } else {
            title.textContent = "Good start — keep going!";
            sub.textContent = `${res.score} out of ${res.total} this time. Every attempt sharpens your memory — try reviewing and take it again.`;
        }

        showToast(`+${res.xpEarned} XP earned for completing the quiz!`, 'success');
        applyXpResult({ xp: (currentUserData?.xp || 0) + res.xpEarned });

        const reviewList = document.getElementById('qz-review-list');
        reviewList.innerHTML = qzQuestions.map((q, i) => {
            const userAns = qzAnswers[i];
            const correct = userAns === q.correctIndex;
            return `
                <div class="glass qz-review-item ${correct ? 'qz-review-correct' : 'qz-review-wrong'}">
                    <p style="font-weight:700; margin-bottom:8px;">${i + 1}. ${escapeHtml(q.question)}</p>
                    <p style="font-size:13.5px; color: var(--text-secondary);">
                        Your answer: ${escapeHtml(q.options[userAns] ?? 'Skipped')} ${correct ? '✅' : `❌ — Correct answer: ${escapeHtml(q.options[q.correctIndex])}`}
                    </p>
                    ${q.explanation ? `<p style="font-size:13px; color: var(--text-secondary); margin-top:6px;"><i class="fa-regular fa-lightbulb"></i> ${escapeHtml(q.explanation)}</p>` : ''}
                </div>
            `;
        }).join('');
    } catch (err) {
        showToast("Quiz complete, but couldn't save your score.", 'info');
    }
}

document.getElementById('qz-retry-btn')?.addEventListener('click', resetQuizUI);
document.getElementById('qz-review-answers-btn')?.addEventListener('click', () => {
    const list = document.getElementById('qz-review-list');
    list.style.display = list.style.display === 'none' ? 'block' : 'none';
});

// ═══════════════════════════════════════════════════════════════════
//  VOICE INPUT (Speech-to-Text dictation for AI chat)
// ═══════════════════════════════════════════════════════════════════

(function setupVoiceInput() {
    const voiceBtn = document.getElementById('grok-voice-btn');
    const chatInput = document.getElementById('grok-chat-input');
    if (!voiceBtn || !chatInput) return;

    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) {
        voiceBtn.title = 'Voice input is not supported in this browser';
        voiceBtn.style.opacity = '0.4';
        voiceBtn.style.cursor = 'not-allowed';
        voiceBtn.addEventListener('click', () => {
            showToast('Voice dictation works in Chrome, Edge and Safari.', 'info');
        });
        return;
    }

    const recognition = new SpeechRecognitionAPI();
    // The browser ends a recognition run of its own accord — after a pause in
    // speech, or every minute or so regardless. While the student still has
    // the mic on, that end is not a stop: it is restarted below, so thinking
    // mid-sentence no longer switches the mic off.
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = document.documentElement.lang === 'hi' ? 'hi-IN' : 'en-IN';

    let wantListening = false;      // what the student asked for
    let running = false;            // what the engine is actually doing
    let baseText = '';              // input text before this dictation began
    let finalText = '';             // everything finalised during it
    let restartTimer = null;

    const setButton = (on) => {
        voiceBtn.classList.toggle('grok-voice-active', on);
        voiceBtn.innerHTML = on
            ? '<i class="fa-solid fa-microphone-lines fa-fade"></i>'
            : '<i class="fa-solid fa-microphone"></i>';
        voiceBtn.title = on ? 'Stop dictation' : 'Voice input (dictation)';
        voiceBtn.setAttribute('aria-pressed', String(on));
    };

    const start = () => {
        if (running) return;
        try {
            recognition.start();
        } catch (e) {
            // start() throws if the engine has not finished stopping yet;
            // the 'end' handler will try again.
        }
    };

    const stop = () => {
        wantListening = false;
        clearTimeout(restartTimer);
        try { recognition.stop(); } catch (e) { /* already stopped */ }
        setButton(false);
    };

    recognition.addEventListener('start', () => {
        running = true;
        setButton(true);
    });

    recognition.addEventListener('result', (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const chunk = e.results[i][0].transcript;
            if (e.results[i].isFinal) finalText += (finalText && !/\s$/.test(finalText) ? ' ' : '') + chunk.trim();
            else interim += chunk;
        }
        chatInput.value = (baseText + finalText + (interim ? ` ${interim.trim()}` : '')).replace(/\s+/g, ' ').trimStart();
        chatInput.dispatchEvent(new Event('input'));
    });

    recognition.addEventListener('end', () => {
        running = false;
        if (!wantListening) { setButton(false); return; }
        // Still listening as far as the student is concerned — pick the mic
        // straight back up. The small delay keeps Chrome from refusing a
        // start() that lands too soon after the previous run ended.
        clearTimeout(restartTimer);
        restartTimer = setTimeout(start, 250);
    });

    recognition.addEventListener('error', (e) => {
        // 'no-speech' and 'aborted' are ordinary during a long dictation and
        // are handled by the restart in 'end'. The rest end the session.
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'permission-denied') {
            wantListening = false;
            setButton(false);
            showToast('Mic access is blocked — allow it in your browser settings to use voice input.', 'error');
            return;
        }
        if (e.error === 'audio-capture') {
            wantListening = false;
            setButton(false);
            showToast('No microphone found.', 'error');
            return;
        }
        if (e.error !== 'no-speech' && e.error !== 'aborted') {
            showToast('Voice input hit a snag — still listening, keep speaking.', 'info');
        }
    });

    voiceBtn.addEventListener('click', () => {
        if (wantListening) {
            stop();
            chatInput.focus();
            return;
        }
        wantListening = true;
        baseText = chatInput.value ? chatInput.value.trimEnd() + ' ' : '';
        finalText = '';
        setButton(true);
        showToast('Listening — tap the mic again when you are done 🎙️', 'info');
        start();
    });

    // Sending a message finishes the dictation, and so does leaving the page.
    document.getElementById('grok-send-btn')?.addEventListener('click', () => { if (wantListening) stop(); });
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && wantListening) stop();
    });
    window.addEventListener('pagehide', stop);
})();

// Register the service worker for installable/offline PWA support
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {
            // Non-fatal — the app still works fully online without it
        });
    });
}

// ═══════════════════════════════════════════════════════════════════
//  WEAKNESS RADAR — hand-drawn SVG spider chart from quiz history
// ═══════════════════════════════════════════════════════════════════

function buildRadarSVG(labels, values) {
    const size = 320;
    const center = size / 2;
    const maxRadius = center - 56;
    const n = labels.length;
    const angleStep = (Math.PI * 2) / n;

    const pointAt = (i, valuePct) => {
        const angle = angleStep * i - Math.PI / 2;
        const r = (valuePct / 100) * maxRadius;
        return [center + r * Math.cos(angle), center + r * Math.sin(angle)];
    };

    // Background rings at 25/50/75/100%
    let rings = '';
    [25, 50, 75, 100].forEach(pct => {
        const pts = labels.map((_, i) => pointAt(i, pct).join(',')).join(' ');
        rings += `<polygon points="${pts}" fill="none" stroke="var(--border-color)" stroke-width="1"/>`;
    });

    // Spokes
    let spokes = '';
    labels.forEach((_, i) => {
        const [x, y] = pointAt(i, 100);
        spokes += `<line x1="${center}" y1="${center}" x2="${x}" y2="${y}" stroke="var(--border-color)" stroke-width="1"/>`;
    });

    // Data polygon
    const dataPts = values.map((v, i) => pointAt(i, v).join(',')).join(' ');
    const dataPolygon = `<polygon points="${dataPts}" fill="rgba(37,99,235,0.18)" stroke="var(--accent-primary)" stroke-width="2.5"/>`;
    const dataDots = values.map((v, i) => {
        const [x, y] = pointAt(i, v);
        return `<circle cx="${x}" cy="${y}" r="4" fill="var(--accent-primary)"/>`;
    }).join('');

    // Labels
    const labelEls = labels.map((label, i) => {
        const [x, y] = pointAt(i, 122);
        const pct = values[i];
        const color = pct >= 70 ? 'var(--success-color)' : pct >= 40 ? 'var(--warning-color)' : 'var(--danger-color)';
        return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" font-size="11" font-weight="700" fill="var(--text-primary)">${escapeHtml(label.length > 14 ? label.substring(0, 13) + '…' : label)}</text>
                 <text x="${x}" y="${y + 13}" text-anchor="middle" font-size="10" font-weight="800" fill="${color}">${pct}%</text>`;
    }).join('');

    return `<svg viewBox="0 0 ${size} ${size}" width="100%" style="max-width: 360px; display:block; margin: 0 auto;">
        ${rings}${spokes}${dataPolygon}${dataDots}${labelEls}
    </svg>`;
}

async function loadWeaknessRadar() {
    const card = document.getElementById('weakness-radar-card');
    const container = document.getElementById('wr-radar-container');
    const practiceBtn = document.getElementById('wr-practice-weakest-btn');
    if (!card || !container || !authToken) return;

    try {
        const { topics, hasData } = await api.getWeaknessRadar(authToken);
        if (!hasData || topics.length < 2) {
            // Need at least a couple of distinct quiz topics for a meaningful radar
            card.style.display = 'none';
            return;
        }

        card.style.display = 'block';
        const labels = topics.map(t => t.topic);
        const values = topics.map(t => t.mastery);
        container.innerHTML = buildRadarSVG(labels, values);

        const weakest = topics.reduce((min, t) => t.mastery < min.mastery ? t : min, topics[0]);
        if (weakest.mastery < 70) {
            practiceBtn.style.display = 'inline-flex';
            practiceBtn.onclick = () => {
                document.querySelector('.nav-item[data-target="quiz-generator"]')?.click();
                setTimeout(() => {
                    const topicInput = document.getElementById('qz-topic');
                    if (topicInput) topicInput.value = weakest.topic;
                }, 150);
            };
        } else {
            practiceBtn.style.display = 'none';
        }
    } catch (e) {
        card.style.display = 'none';
    }
}

// ═══════════════════════════════════════════════════════════════════
//  AI PERSONALIZED EXAM STUDY ROADMAP
// ═══════════════════════════════════════════════════════════════════

let rmCurrentPlan = null;

// Default the date picker to 2 weeks out so the field never looks broken/empty
(function initRoadmapDateDefault() {
    const dateInput = document.getElementById('rm-exam-date');
    if (dateInput) {
        const twoWeeksOut = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
        dateInput.min = new Date().toISOString().split('T')[0];
        dateInput.value = twoWeeksOut.toISOString().split('T')[0];
    }
})();

document.getElementById('rm-generate-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('rm-generate-btn');
    const status = document.getElementById('rm-generate-status');
    const examName = document.getElementById('rm-exam-name').value.trim();
    const examDate = document.getElementById('rm-exam-date').value;
    const topics = document.getElementById('rm-topics').value.trim();
    const hoursPerDay = document.getElementById('rm-hours').value;

    if (!examName || !examDate || topics.length < 5) {
        showToast('Add your exam name, date, and at least a few topics to plan around.', 'info');
        return;
    }

    btn.disabled = true;
    status.style.display = 'block';
    try {
        const res = await api.generateStudyRoadmap(authToken, { examName, examDate, topics, hoursPerDay });
        rmCurrentPlan = res;
        renderRoadmap(res);
        showToast(`Your ${res.daysUntil}-day roadmap is ready — you've got this! 💪`, 'success');
        api.addXp(authToken, 10, 5, 'Study Roadmap Generation').then(r => applyXpResult(r));
    } catch (err) {
        showToast(err.message || "Couldn't generate the roadmap — please try again.", 'error');
    } finally {
        btn.disabled = false;
        status.style.display = 'none';
    }
});

const RM_TYPE_META = {
    study: { icon: 'fa-solid fa-book-open', color: 'var(--accent-primary)', label: 'Study' },
    flashcard_review: { icon: 'fa-solid fa-layer-group', color: '#8B5CF6', label: 'Flashcard Review' },
    mock_quiz: { icon: 'fa-solid fa-circle-question', color: 'var(--warning-color)', label: 'Mock Quiz' },
    milestone: { icon: 'fa-solid fa-flag-checkered', color: 'var(--success-color)', label: 'Milestone' },
    rest: { icon: 'fa-solid fa-mug-hot', color: 'var(--text-secondary)', label: 'Rest / Light Review' }
};

function renderRoadmap(res) {
    document.getElementById('rm-results-box').style.display = 'block';
    document.getElementById('rm-results-title').textContent = `${res.examName} — ${res.daysUntil}-Day Plan`;
    document.getElementById('rm-results-sub').textContent = `Exam date: ${new Date(res.examDate).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;

    const timeline = document.getElementById('rm-timeline');
    timeline.innerHTML = res.plan.map(day => {
        const meta = RM_TYPE_META[day.type] || RM_TYPE_META.study;
        return `
            <div class="rm-day-row">
                <div class="rm-day-marker" style="background:${meta.color};"><i class="${meta.icon}"></i></div>
                <div class="rm-day-content">
                    <div class="rm-day-top">
                        <span class="rm-day-num">Day ${day.day}</span>
                        <span class="rm-day-date">${new Date(day.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                        <span class="rm-day-type-pill" style="color:${meta.color}; background:${meta.color}1a;">${meta.label}</span>
                    </div>
                    <p>${escapeHtml(day.focus)}</p>
                </div>
            </div>
        `;
    }).join('');
}

document.getElementById('rm-export-ics-btn')?.addEventListener('click', () => {
    if (!rmCurrentPlan) return;
    const ics = buildICS(rmCurrentPlan);
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${rmCurrentPlan.examName.replace(/[^a-z0-9]+/gi, '-')}-study-roadmap.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Roadmap exported — import the .ics file into Google Calendar, Apple Calendar, or Outlook.', 'success');
});

function icsDate(dateStr) {
    return dateStr.replace(/-/g, '');
}

function buildICS(res) {
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//StudyHub//Exam Study Roadmap//EN',
        'CALSCALE:GREGORIAN'
    ];

    res.plan.forEach((day, i) => {
        const meta = RM_TYPE_META[day.type] || RM_TYPE_META.study;
        const dateOnly = icsDate(day.date);
        // All-day event: DTSTART is the day, DTEND is the next day (exclusive, per iCal spec)
        const nextDay = new Date(day.date);
        nextDay.setDate(nextDay.getDate() + 1);
        const dateEnd = icsDate(nextDay.toISOString().split('T')[0]);

        lines.push(
            'BEGIN:VEVENT',
            `UID:studyhub-roadmap-${res.examName.replace(/[^a-z0-9]+/gi, '')}-day${day.day}@studyhub`,
            `DTSTAMP:${icsDate(new Date().toISOString().split('T')[0])}T000000Z`,
            `DTSTART;VALUE=DATE:${dateOnly}`,
            `DTEND;VALUE=DATE:${dateEnd}`,
            `SUMMARY:${meta.label} — ${res.examName} (Day ${day.day})`,
            `DESCRIPTION:${String(day.focus).replace(/\n/g, '\\n')}`,
            'END:VEVENT'
        );
    });

    // Final event on the exam day itself
    lines.push(
        'BEGIN:VEVENT',
        `UID:studyhub-roadmap-${res.examName.replace(/[^a-z0-9]+/gi, '')}-examday@studyhub`,
        `DTSTAMP:${icsDate(new Date().toISOString().split('T')[0])}T000000Z`,
        `DTSTART;VALUE=DATE:${icsDate(res.examDate)}`,
        `SUMMARY:🎯 ${res.examName} — Exam Day!`,
        `DESCRIPTION:You've prepared for this. Good luck!`,
        'END:VEVENT'
    );

    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
}

// ================================================================
// TEACHER: WORKSHEET RESULTS, ITEM ANALYSIS & ONE-CLICK RETEACH
// ----------------------------------------------------------------
// The point of storing per-question answers: show the teacher which
// questions the class actually missed, then turn that straight into
// the next worksheet.
// ================================================================
(function () {
    const listEl = document.getElementById('ws-results-list');
    const modal = document.getElementById('ws-analysis-modal');
    if (!listEl || !modal) return;

    let currentAnalysis = null;
    let currentWorksheetId = null;

    function pctClass(pct) {
        if (pct === null || pct === undefined) return 'ws-bar-none';
        if (pct < 40) return 'ws-bar-bad';
        if (pct < 70) return 'ws-bar-mid';
        return 'ws-bar-good';
    }

    async function loadResults() {
        listEl.innerHTML = '<div class="ws-results-empty">Loading…</div>';
        try {
            const { worksheets } = await api.listTeacherWorksheets(authToken);
            if (!worksheets.length) {
                listEl.innerHTML = '<div class="ws-results-empty">No worksheets published yet. Generate one above and publish it to a class.</div>';
                return;
            }
            listEl.innerHTML = worksheets.map((w) => {
                const done = Number(w.submissions) || 0;
                const total = Number(w.enrolled) || 0;
                const ratio = total ? Math.round((done / total) * 100) : 0;
                return `
                <div class="ws-result-row">
                    <div class="ws-result-main">
                        <h4>${escapeHtml(w.title)}</h4>
                        <p>${escapeHtml(w.class_name || '')}${w.class_section ? '-' + escapeHtml(w.class_section) : ''}
                           · ${escapeHtml(w.subject || 'General')} · ${w.total_marks} marks</p>
                    </div>
                    <div class="ws-result-meta">
                        <div class="ws-submit-count"><strong>${done}</strong>/${total || '?'} submitted</div>
                        <div class="ws-bar"><span class="${pctClass(ratio)}" style="width:${ratio}%"></span></div>
                    </div>
                    <button class="btn btn-secondary ws-analyse-btn" data-ws="${w.id}" ${done === 0 ? 'disabled title="No submissions yet"' : ''}>
                        <i class="fa-solid fa-chart-simple"></i> Analysis
                    </button>
                </div>`;
            }).join('');
        } catch (err) {
            listEl.innerHTML = `<div class="ws-results-empty">Could not load results: ${escapeHtml(err.message)}</div>`;
        }
    }

    function renderAnalysis(data) {
        currentAnalysis = data;
        document.getElementById('ws-analysis-title').textContent = data.worksheet.title;
        document.getElementById('ws-analysis-sub').textContent =
            `${data.summary.submissions} submission${data.summary.submissions === 1 ? '' : 's'} · out of ${data.worksheet.total_marks} marks`;

        const weakest = data.summary.weakest[0];
        document.getElementById('ws-analysis-stats').innerHTML = `
            <div class="ws-stat"><span class="ws-stat-val">${data.summary.avgPct ?? '—'}%</span><span class="ws-stat-lbl">Class average</span></div>
            <div class="ws-stat"><span class="ws-stat-val">${data.summary.submissions}</span><span class="ws-stat-lbl">Submitted</span></div>
            <div class="ws-stat"><span class="ws-stat-val">${weakest ? weakest.pctCorrect + '%' : '—'}</span><span class="ws-stat-lbl">Weakest question</span></div>
            ${data.summary.needsReview ? `<div class="ws-stat ws-stat-warn"><span class="ws-stat-val">${data.summary.needsReview}</span><span class="ws-stat-lbl">Need your review</span></div>` : ''}`;

        const sorted = [...data.questions].sort(
            (a, b) => (a.pctCorrect ?? 101) - (b.pctCorrect ?? 101)
        );
        document.getElementById('ws-analysis-questions').innerHTML = sorted.map((q) => {
            const pct = q.pctCorrect;
            const wrong = q.commonWrong.length
                ? `<div class="ws-wrong-list">${q.commonWrong.map((w) =>
                    `<span class="ws-wrong-chip">${escapeHtml(w.answer)} <b>×${w.count}</b></span>`).join('')}</div>`
                : '';
            return `
            <label class="ws-q-row">
                <input type="checkbox" class="ws-q-check" value="${q.id}" ${pct !== null && pct < 70 ? 'checked' : ''}>
                <div class="ws-q-body">
                    <div class="ws-q-top">
                        <span class="ws-q-text">${escapeHtml(q.question)}</span>
                        <span class="ws-q-pct ${pctClass(pct)}-text">${pct === null ? '—' : pct + '%'}</span>
                    </div>
                    <div class="ws-bar"><span class="${pctClass(pct)}" style="width:${pct ?? 0}%"></span></div>
                    <div class="ws-q-meta">${q.correct}/${q.attempted} correct · avg ${q.avgMarks ?? 0}/${q.marks} marks · ${escapeHtml(q.type)}</div>
                    ${wrong}
                </div>
            </label>`;
        }).join('');

        document.getElementById('ws-analysis-students').innerHTML = data.students.map((s) => `
            <div class="ws-student-chip ${s.pct !== null && s.pct < 40 ? 'is-low' : ''}">
                <span class="ws-student-name">${escapeHtml(s.name)}</span>
                <span class="ws-student-score">${s.score}/${s.total}</span>
            </div>`).join('') || '<p class="ws-analysis-hint">No submissions yet.</p>';

        document.getElementById('ws-reteach-preview').style.display = 'none';
        document.getElementById('ws-reteach-preview').innerHTML = '';
    }

    async function openAnalysis(worksheetId) {
        currentWorksheetId = worksheetId;
        modal.style.display = 'flex';
        document.getElementById('ws-analysis-questions').innerHTML = '<p class="ws-analysis-hint">Loading…</p>';
        try {
            const data = await api.getWorksheetAnalysis(authToken, worksheetId);
            renderAnalysis(data);
        } catch (err) {
            document.getElementById('ws-analysis-questions').innerHTML =
                `<p class="ws-analysis-hint">Could not load analysis: ${escapeHtml(err.message)}</p>`;
        }
    }

    listEl.addEventListener('click', (e) => {
        const btn = e.target.closest('.ws-analyse-btn');
        if (btn && !btn.disabled) openAnalysis(btn.dataset.ws);
    });

    document.getElementById('ws-refresh-results-btn')?.addEventListener('click', loadResults);
    document.getElementById('ws-analysis-close')?.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

    // ---- Reteach ----
    document.getElementById('ws-reteach-btn')?.addEventListener('click', async (e) => {
        const ids = [...document.querySelectorAll('.ws-q-check:checked')].map((c) => c.value);
        if (!ids.length) {
            showToast('Tick at least one question to reteach.', 'info');
            return;
        }
        const btn = e.currentTarget;
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Writing a reteach worksheet…';

        const preview = document.getElementById('ws-reteach-preview');
        try {
            const { worksheet } = await api.generateReteachWorksheet(authToken, currentWorksheetId, ids, 5);
            preview.style.display = 'block';
            preview.innerHTML = `
                <div class="ws-reteach-head">
                    <div>
                        <h4>${escapeHtml(worksheet.title || 'Reteach worksheet')}</h4>
                        <p>${worksheet.questions.length} questions · ${worksheet.total_marks || 0} marks · targets ${ids.length} weak concept${ids.length === 1 ? '' : 's'}</p>
                    </div>
                    <button class="btn btn-primary" id="ws-reteach-publish"><i class="fa-solid fa-paper-plane"></i> Publish to class</button>
                </div>
                <ol class="ws-reteach-questions">
                    ${worksheet.questions.map((q) => `
                        <li>
                            <span class="ws-rq-text">${escapeHtml(q.question)}</span>
                            ${Array.isArray(q.options) && q.options.length
                                ? `<div class="ws-rq-opts">${q.options.map((o) =>
                                    `<span class="${String(o) === String(q.correct_answer) ? 'is-answer' : ''}">${escapeHtml(String(o))}</span>`).join('')}</div>`
                                : `<div class="ws-rq-opts"><span class="is-answer">${escapeHtml(String(q.correct_answer || ''))}</span></div>`}
                        </li>`).join('')}
                </ol>`;

            document.getElementById('ws-reteach-publish').addEventListener('click', async (ev) => {
                const pubBtn = ev.currentTarget;
                pubBtn.disabled = true;
                pubBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Publishing…';
                try {
                    await api.publishAIWorksheet(authToken, {
                        classId: currentAnalysis.worksheet.class_id,
                        title: worksheet.title || 'Reteach worksheet',
                        subject: worksheet.subject || 'General',
                        topic: worksheet.title || 'Reteach',
                        total_marks: worksheet.total_marks || 10,
                        duration: worksheet.duration || 15,
                        worksheet_data: worksheet
                    });
                    showToast('Reteach worksheet published to the class ✅', 'success');
                    modal.style.display = 'none';
                    loadResults();
                } catch (err) {
                    showToast(err.message, 'error');
                    pubBtn.disabled = false;
                    pubBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Publish to class';
                }
            });
        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    });

    // Load whenever the teacher opens the AI Worksheets tab.
    document.querySelectorAll('.teacher-nav-item[data-teacher-tab="ai-worksheets"]').forEach((el) => {
        el.addEventListener('click', () => setTimeout(loadResults, 100));
    });
    window.loadTeacherWorksheetResults = loadResults;
    window.openWorksheetAnalysis = openAnalysis;
})();

// Renders the teacher dashboard's "needs attention" queue: worksheets the
// class scored lowest on, each opening straight into the item analysis.
function renderTeacherAttention(items, stats) {
    const card = document.getElementById('teacher-attention-card');
    const list = document.getElementById('teacher-attention-list');
    if (!card || !list) return;

    if (!items || items.length === 0) {
        card.style.display = 'none';
        return;
    }
    card.style.display = 'block';

    const band = (pct) => (pct === null ? 'ws-bar-none' : pct < 40 ? 'ws-bar-bad' : pct < 70 ? 'ws-bar-mid' : 'ws-bar-good');

    list.innerHTML = items.map((it) => `
        <div class="teacher-attention-row">
            <div class="ta-main">
                <h4>${escapeHtml(it.title)}</h4>
                <p>${escapeHtml(it.className)} · ${it.submissions} submission${it.submissions === 1 ? '' : 's'}</p>
            </div>
            <div class="ta-score">
                <span class="ta-pct ${band(it.avgPct)}-text">${it.avgPct === null ? '—' : it.avgPct + '%'}</span>
                <div class="ws-bar"><span class="${band(it.avgPct)}" style="width:${it.avgPct ?? 0}%"></span></div>
            </div>
            <button class="btn btn-secondary ta-open" data-ws="${it.id}">
                <i class="fa-solid fa-chart-simple"></i> Analysis
            </button>
        </div>`).join('');

    if (stats && stats.ungraded > 0) {
        list.insertAdjacentHTML('beforeend',
            `<div class="teacher-attention-note"><i class="fa-solid fa-circle-info"></i> ${stats.ungraded} homework submission${stats.ungraded === 1 ? '' : 's'} still ungraded.</div>`);
    }

    list.querySelectorAll('.ta-open').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (window.openWorksheetAnalysis) window.openWorksheetAnalysis(btn.dataset.ws);
        });
    });
}

// ================================================================
// TEACHER HEADER — user dropdown (mirrors the student topbar menu)
// ================================================================
(function () {
    const wrap = document.getElementById('teacher-profile-wrap');
    const pill = document.getElementById('teacher-profile-pill');
    const drop = document.getElementById('teacher-user-dropdown');
    if (!wrap || !pill || !drop) return;

    const close = () => { wrap.classList.remove('open'); drop.classList.remove('open'); };

    pill.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = drop.classList.contains('open');
        if (open) { close(); } else { wrap.classList.add('open'); drop.classList.add('open'); }
    });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });

    document.getElementById('teacher-drop-classes')?.addEventListener('click', () => {
        close();
        switchTeacherTab('classes', true);
    });
    document.getElementById('teacher-drop-worksheets')?.addEventListener('click', () => {
        close();
        switchTeacherTab('ai-worksheets', true);
        setTimeout(() => window.loadTeacherWorksheetResults && window.loadTeacherWorksheetResults(), 120);
    });
    document.getElementById('teacher-drop-logout')?.addEventListener('click', () => {
        close();
        logout();
    });
})();

// ================================================================
// DEVELOPER HEADER — user dropdown (same pattern as the other portals)
// ================================================================
(function () {
    const wrap = document.getElementById('devhub-profile-wrap');
    const pill = document.getElementById('devhub-profile-pill');
    const drop = document.getElementById('devhub-user-dropdown');
    if (!wrap || !pill || !drop) return;

    const close = () => { wrap.classList.remove('open'); drop.classList.remove('open'); };

    pill.addEventListener('click', (e) => {
        e.stopPropagation();
        if (drop.classList.contains('open')) { close(); }
        else { wrap.classList.add('open'); drop.classList.add('open'); }
    });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });

    document.getElementById('devhub-drop-skills')?.addEventListener('click', () => {
        close();
        if (typeof switchDevTab === 'function') switchDevTab('skills', true);
    });
    document.getElementById('devhub-drop-tests')?.addEventListener('click', () => {
        close();
        if (typeof switchDevTab === 'function') switchDevTab('tests', true);
    });
    document.getElementById('devhub-drop-logout')?.addEventListener('click', () => {
        close();
        logout();
    });
})();

// ================================================================
// STUDENT: MARKED WORKSHEET RESULT
// ----------------------------------------------------------------
// Grading writes a mark and a sentence of feedback for every question.
// This renders that, so the student sees why they scored what they did
// instead of just a number.
// ================================================================
function renderWorksheetResult(data) {
    const modal = document.getElementById('worksheet-player-modal');
    const view = document.getElementById('player-result-view');
    const summary = document.getElementById('player-result-summary');
    const list = document.getElementById('player-result-list');
    if (!modal || !view || !summary || !list) return;

    // Swap the paper for the marked version.
    document.getElementById('player-questions-container').style.display = 'none';
    document.getElementById('player-submit-row').style.display = 'none';
    document.getElementById('player-timer-pill').style.display = 'none';
    view.style.display = 'block';
    modal.style.display = 'flex';

    const total = data.totalPossible || 0;
    const pct = total ? Math.round((data.score / total) * 100) : 0;
    const band = pct >= 70 ? 'good' : pct >= 40 ? 'mid' : 'bad';
    const verdict = pct >= 70 ? 'Well done' : pct >= 40 ? 'Nearly there' : 'Worth another look';

    summary.innerHTML = `
        <div class="ws-result-score ws-res-${band}">
            <span class="ws-result-pct">${pct}%</span>
            <span class="ws-result-frac">${data.score} / ${total} marks</span>
        </div>
        <div class="ws-result-verdict">
            <h4>${verdict}</h4>
            <p>${data.xpEarned ? `+${data.xpEarned} XP earned. ` : ''}Every question is marked below with the correct answer.</p>
        </div>`;

    const results = data.results || [];
    if (results.length === 0) {
        list.innerHTML = '<p class="ws-analysis-hint">No per-question breakdown available for this attempt.</p>';
    } else {
        list.innerHTML = results.map((r, i) => {
            const state = r.correct === true ? 'correct' : r.correct === false ? 'wrong' : 'partial';
            const icon = state === 'correct' ? 'fa-circle-check' : state === 'wrong' ? 'fa-circle-xmark' : 'fa-circle-half-stroke';
            const gave = (r.answer === null || String(r.answer).trim() === '')
                ? '<em>No answer given</em>'
                : escapeHtml(String(r.answer));
            const showCorrect = state !== 'correct' && r.correct_answer;
            return `
            <div class="ws-result-item is-${state}">
                <div class="ws-result-head">
                    <i class="fa-solid ${icon}"></i>
                    <span class="ws-result-q">${i + 1}. ${escapeHtml(r.question)}</span>
                    <span class="ws-result-marks">${r.awarded}/${r.marks}</span>
                </div>
                <div class="ws-result-body">
                    <div class="ws-result-row"><span class="ws-result-label">Your answer</span><span class="ws-result-val">${gave}</span></div>
                    ${showCorrect ? `<div class="ws-result-row"><span class="ws-result-label">Correct answer</span><span class="ws-result-val is-answer">${escapeHtml(String(r.correct_answer))}</span></div>` : ''}
                    ${r.feedback ? `<p class="ws-result-feedback"><i class="fa-solid fa-comment-dots"></i> ${escapeHtml(r.feedback)}</p>` : ''}
                    ${r.explanation && state !== 'correct' ? `<p class="ws-result-explain"><i class="fa-solid fa-lightbulb"></i> ${escapeHtml(r.explanation)}</p>` : ''}
                    ${r.needsReview ? '<p class="ws-result-review"><i class="fa-solid fa-user-pen"></i> Provisional mark — your teacher will review this one.</p>' : ''}
                </div>
            </div>`;
        }).join('');
    }

    list.scrollIntoView?.({ block: 'nearest' });
}

// Reopen a graded attempt later.
async function openWorksheetResult(worksheetId) {
    try {
        const data = await api.getMyWorksheetResult(authToken, worksheetId);
        renderWorksheetResult(data);
        document.getElementById('player-ws-title').textContent = data.title || 'Worksheet result';
        document.getElementById('player-ws-meta').textContent =
            `Submitted ${data.submitted_at ? new Date(data.submitted_at).toLocaleString() : ''}`;
    } catch (err) {
        showToast(err.message || 'Could not load your result', 'error');
    }
}
window.openWorksheetResult = openWorksheetResult;

document.getElementById('player-result-done-btn')?.addEventListener('click', () => {
    document.getElementById('worksheet-player-modal').style.display = 'none';
    // Restore the player for the next worksheet.
    document.getElementById('player-questions-container').style.display = '';
    document.getElementById('player-submit-row').style.display = '';
    document.getElementById('player-timer-pill').style.display = '';
    document.getElementById('player-result-view').style.display = 'none';
    if (typeof currentStudentClassId !== 'undefined' && currentStudentClassId) {
        openStudentClassDetail(currentStudentClassId);
    }
});

// ================================================================
// NOTIFICATIONS — shared across all three portals
// ----------------------------------------------------------------
// The endpoints and the rows already existed (notifyClassStudents()
// inserts on every publish); nothing was ever fetching them and no
// bell had a click handler.
// ================================================================
(function () {
    const NOTIF_ICONS = {
        worksheet: 'fa-file-pen',
        homework: 'fa-book-open',
        announcement: 'fa-bullhorn',
        note: 'fa-file-lines'
    };

    let cache = [];

    function timeAgo(iso) {
        if (!iso) return '';
        const then = new Date(iso.replace(' ', 'T'));
        const mins = Math.floor((Date.now() - then.getTime()) / 60000);
        if (Number.isNaN(mins)) return '';
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        const days = Math.floor(hrs / 24);
        return days === 1 ? 'yesterday' : `${days}d ago`;
    }

    function paintBadges(count) {
        document.querySelectorAll('[data-notif-count]').forEach((el) => {
            el.textContent = count > 9 ? '9+' : String(count);
            el.style.display = count > 0 ? 'flex' : 'none';
        });
    }

    function paintPanels() {
        const body = cache.length === 0
            ? '<div class="notif-empty"><i class="fa-regular fa-bell-slash"></i><p>Nothing new right now.</p></div>'
            : cache.map((n) => `
                <div class="notif-item ${n.is_read ? '' : 'is-unread'}" data-ref-type="${n.reference_type || ''}" data-ref-id="${n.reference_id || ''}">
                    <div class="notif-icon"><i class="fa-solid ${NOTIF_ICONS[n.type] || 'fa-circle-info'}"></i></div>
                    <div class="notif-text">
                        <h5>${escapeHtml(n.title || 'Update')}</h5>
                        <p>${escapeHtml(n.message || '')}</p>
                        <span class="notif-time">${timeAgo(n.created_at)}</span>
                    </div>
                </div>`).join('');

        document.querySelectorAll('[data-notif-panel]').forEach((panel) => {
            panel.innerHTML = `
                <div class="notif-head">
                    <span>Notifications</span>
                    ${cache.some(n => !n.is_read) ? '<button type="button" class="notif-mark" data-notif-mark>Mark all read</button>' : ''}
                </div>
                <div class="notif-list">${body}</div>`;
        });
    }

    async function refresh() {
        if (!authToken) return;
        try {
            const data = await api.getClassNotifications(authToken);
            if (!data || !data.success) return;
            cache = data.notifications || [];
            paintBadges(Number(data.unreadCount) || 0);
            paintPanels();
        } catch (e) {
            // Non-fatal — a bell that can't load shouldn't break the page.
        }
    }

    function closeAll() {
        document.querySelectorAll('[data-notif-panel]').forEach(p => p.classList.remove('open'));
    }

    document.addEventListener('click', async (e) => {
        const markBtn = e.target.closest('[data-notif-mark]');
        if (markBtn) {
            e.stopPropagation();
            try { await api.markClassNotificationsRead(authToken); } catch (err) { /* non-fatal */ }
            cache = cache.map(n => ({ ...n, is_read: 1 }));
            paintBadges(0);
            paintPanels();
            return;
        }

        const btn = e.target.closest('[data-notif-btn]');
        if (btn) {
            e.stopPropagation();
            const panel = btn.parentElement.querySelector('[data-notif-panel]');
            const wasOpen = panel.classList.contains('open');
            closeAll();
            if (!wasOpen) {
                panel.classList.add('open');
                refresh();
            }
            return;
        }

        if (!e.target.closest('[data-notif-panel]')) closeAll();
    });

    // Jump to the thing the notification is about.
    document.addEventListener('click', (e) => {
        const item = e.target.closest('.notif-item');
        if (!item) return;
        const type = item.dataset.refType;
        closeAll();
        if (type === 'worksheet' || type === 'homework' || type === 'note') {
            if (typeof navigateToSection === 'function') navigateToSection('classroom', true);
        }
    });

    window.refreshNotifications = refresh;
    // Poll gently so a published worksheet shows up without a reload.
    setInterval(() => {
        if (authToken && !document.hidden) refresh();
    }, 90000);
    setTimeout(refresh, 2500);
})();

// ================================================================
// AI COMPANION — conversation memory
// ----------------------------------------------------------------
// Restores the last thread so context survives a refresh, and lists
// recent conversations so a student can pick one back up.
// ================================================================
async function restoreChatThread() {
    if (!authToken || !activeChatThreadId || !grokChatStream) return;
    try {
        const data = await api.getChatThread(authToken, activeChatThreadId);
        if (!data || !data.success || !data.messages || data.messages.length === 0) return;

        setGrokWelcomeVisible(false);
        // Keep the welcome node in the DOM so New Chat can bring it back.
        [...grokChatStream.children].forEach((c) => {
            if (c.id !== 'grok-welcome-view') c.remove();
        });

        data.messages.forEach((m) => {
            const row = document.createElement('div');
            if (m.role === 'user') {
                row.className = 'grok-msg-row grok-msg-user';
                row.innerHTML = `<div class="grok-user-bubble">${escapeHtml(m.content)}</div>`;
            } else {
                row.className = 'grok-msg-row grok-msg-ai';
                const body = renderAiMarkdown(m.content);
                row.innerHTML = `<div class="grok-ai-bubble">${body}</div>`;
            }
            grokChatStream.appendChild(row);
            if (m.role !== 'user') renderChatMath(row);
        });

        grokChatStream.scrollTop = grokChatStream.scrollHeight;
        if (typeof renderMathInElement === 'function') {
            try {
                renderMathInElement(grokChatStream, {
                    delimiters: [
                        { left: '$$', right: '$$', display: true },
                        { left: '$', right: '$', display: false }
                    ],
                    throwOnError: false
                });
            } catch (e) { /* non-fatal */ }
        }
    } catch (e) {
        console.warn('[CHAT] could not restore thread:', e.message);
    }
}

async function renderRecentChats() {
    const wrap = document.getElementById('grok-recent-chats');
    if (!wrap || !authToken) return;
    try {
        const data = await api.listChatThreads(authToken);
        const threads = (data && data.threads) || [];
        const withMessages = threads.filter(t => t.message_count > 0);
        if (withMessages.length === 0) {
            wrap.style.display = 'none';
            return;
        }
        wrap.style.display = 'flex';
        wrap.innerHTML = `
            <span class="grok-rail-label"><i class="fa-solid fa-clock-rotate-left"></i> Recent</span>
            <div class="grok-rail-chips">
                ${withMessages.slice(0, 6).map(t => `
                    <button type="button" class="grok-thread-chip ${String(t.id) === String(activeChatThreadId) ? 'is-active' : ''}" data-thread="${t.id}">
                        ${escapeHtml(t.title || 'Chat')}
                    </button>`).join('')}
            </div>`;

        wrap.querySelectorAll('.grok-thread-chip').forEach((btn) => {
            btn.addEventListener('click', async () => {
                activeChatThreadId = Number(btn.dataset.thread);
                try { localStorage.setItem('activeChatThreadId', String(activeChatThreadId)); } catch (e) {}
                await restoreChatThread();
                renderRecentChats();
            });
        });
    } catch (e) {
        wrap.style.display = 'none';
    }
}

// Restore once the app has a session.
setTimeout(() => {
    if (authToken) {
        restoreChatThread();
        renderRecentChats();
    }
}, 2200);

// ================================================================
// LEGAL / TRUST DOCUMENTS
// ----------------------------------------------------------------
// Written against what the code actually does — the vendor list below
// is the real set of third parties that receive data. If you add an
// integration, update this or the policy becomes false.
//
// [REVIEW] markers are things only you can decide (legal entity,
// jurisdiction, grievance officer). This is honest disclosure, not
// legal advice — have a lawyer review before launching publicly,
// especially the section on students under 18.
// ================================================================
const LEGAL_UPDATED = 'August 2026';

const LEGAL_DOCS = {
    privacy: `
<h3>Privacy Policy</h3>
<p class="legal-meta">Last updated: ${LEGAL_UPDATED}</p>

<h4>Who we are</h4>
<p>StudyHub is operated by ExamPrism AI, India. <span class="legal-todo">[REVIEW] Add your registered legal entity name and address.</span>
Contact: <a href="mailto:support@learnonline.study">support@learnonline.study</a>.</p>

<h4>What we store</h4>
<ul>
  <li><strong>Account</strong> — your username or email, and a hashed password. We never store your password in readable form.</li>
  <li><strong>Learning activity</strong> — XP, level, streaks, time spent, tools used.</li>
  <li><strong>Your work</strong> — notes, flashcards, quiz and worksheet attempts, your answers, the marks awarded and the feedback written for each answer.</li>
  <li><strong>Classroom data</strong> — classes you join, and homework or worksheets your teacher publishes to them.</li>
  <li><strong>AI conversations</strong> — your chats with the AI Companion, and facts you ask it to remember.</li>
</ul>

<h4>Who your data is sent to</h4>
<p>When you use an AI feature, your prompt is sent to an AI provider. That prompt can include your name, class, recent scores and the questions you got wrong, because the tutor uses them to give relevant help.</p>
<ul>
  <li><strong>Groq</strong> (United States) — AI text generation. Receives prompts and conversation history.</li>
  <li><strong>Google Gemini</strong> — used only as a fallback if Groq is unavailable.</li>
  <li><strong>Sarvam AI</strong> (India) — text-to-speech. Receives the text to be read aloud, which may include your first name.</li>
  <li><strong>Pollinations.ai</strong> — image generation. Receives only the image prompt you type.</li>
</ul>
<p>We do not sell your data, and we do not use it for advertising.</p>

<h4>What stays on your device</h4>
<p>PDF text extraction and image OCR run entirely in your browser. Those files are not uploaded to us unless you paste the extracted text into a tool.</p>

<h4>Students under 18</h4>
<p class="legal-warn"><strong>Important.</strong> This service is used by school students, and India's Digital Personal Data Protection Act, 2023 requires verifiable parental consent before processing a child's personal data.
<span class="legal-todo">[REVIEW] You must implement parental consent and confirm your lawful basis before onboarding minors at scale. Please get this reviewed by a lawyer.</span></p>

<h4>Your rights</h4>
<p>You can export or delete your account at any time from Profile Settings — "Delete Account &amp; All Data" removes your record and its associated work from our database. You can also email us to request access, correction or erasure.</p>

<h4>Retention</h4>
<p>We keep your data while your account is active. Deleting your account removes it. <span class="legal-todo">[REVIEW] Confirm your backup retention window.</span></p>
`,

    terms: `
<h3>Terms of Use</h3>
<p class="legal-meta">Last updated: ${LEGAL_UPDATED}</p>

<h4>What StudyHub is</h4>
<p>StudyHub gives students AI-assisted study tools and gives teachers tools to generate, publish and mark practice worksheets. You need an account to use it.</p>

<h4>AI output is not guaranteed correct</h4>
<p>Answers, worksheets, marks and feedback are generated by AI models and <strong>can be wrong</strong>. Do not rely on them as your only source for exams or assessment. Teachers should review AI-assigned marks before treating them as final — written answers are marked by AI and flagged for review where the system is unsure.</p>

<h4>Certificates and badges</h4>
<p>Certificates, badges and scores issued here are records of practice on this platform. <strong>They are not accredited by any examination board or external authority</strong> and carry no formal academic value.</p>

<h4>Acceptable use</h4>
<ul>
  <li>Don't use the service to cheat in a real examination or to misrepresent AI work as your own where that is prohibited.</li>
  <li>Don't upload content you don't have the right to share.</li>
  <li>Don't attempt to overload, scrape or reverse-engineer the service.</li>
  <li>One account per person. Teacher and student accounts are separate by design.</li>
</ul>

<h4>Availability</h4>
<p>We aim to keep the service running but we don't promise uninterrupted availability. AI features depend on third-party providers and may be rate-limited or temporarily unavailable.</p>

<h4>Liability</h4>
<p>The service is provided "as is". To the extent permitted by law, we are not liable for indirect loss, or for academic outcomes arising from reliance on AI-generated content. <span class="legal-todo">[REVIEW] Add governing law and jurisdiction.</span></p>
`,

    contact: `
<h3>Contact</h3>
<p class="legal-meta">We reply to most messages within 2 working days.</p>
<h4>Support</h4>
<p><a href="mailto:support@learnonline.study">support@learnonline.study</a> — accounts, bugs, and data requests (access, correction, deletion).</p>
<h4>Who runs this</h4>
<p>StudyHub is built by <strong>ExamPrism AI</strong>, India.
<span class="legal-todo">[REVIEW] Add your registered address and, for DPDP compliance, a named Grievance Officer with contact details.</span></p>
<h4>Schools</h4>
<p>If you're a school or teacher wanting to use StudyHub with a class, email us — we'll help you set up classrooms and rosters.</p>
`
};

(function () {
    const modal = document.getElementById('legal-modal');
    const body = document.getElementById('legal-body');
    if (!modal || !body) return;

    function show(doc) {
        const key = LEGAL_DOCS[doc] ? doc : 'privacy';
        body.innerHTML = LEGAL_DOCS[key];
        body.scrollTop = 0;
        document.querySelectorAll('.legal-tab').forEach((t) => {
            t.classList.toggle('is-active', t.dataset.legalTab === key);
        });
        modal.style.display = 'flex';
    }
    window.openLegalDoc = show;

    document.addEventListener('click', (e) => {
        const link = e.target.closest('[data-legal]');
        if (link) {
            e.preventDefault();
            show(link.dataset.legal);
            return;
        }
        const tab = e.target.closest('.legal-tab');
        if (tab) { show(tab.dataset.legalTab); return; }
    });

    document.getElementById('legal-close')?.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
})();

// ================================================================
// STUDY PROFILE — board / class / subject
// ----------------------------------------------------------------
// Stored as memory facts, so they reach every AI request through
// buildStudyContext() and ground answers in the right textbook and
// the right depth for that class.
// ================================================================
(function () {
    const bar = document.getElementById('grok-syllabus-bar');
    if (!bar) return;

    const board = document.getElementById('syl-board');
    const cls = document.getElementById('syl-class');
    const subject = document.getElementById('syl-subject');
    const status = document.getElementById('syl-status');

    function describe() {
        if (!board.value && !cls.value) return '';
        const bits = [cls.value ? `Class ${cls.value}` : null, subject.value || null, board.value || null].filter(Boolean);
        return `Answers follow the ${bits.join(' ')} syllabus`;
    }

    function paint(saved) {
        const text = describe();
        status.textContent = saved && text ? `${text} ✓` : text;
        status.classList.toggle('is-set', Boolean(text));
    }

    async function save() {
        paint(false);
        try {
            await Promise.all([
                board.value ? api.setAiMemory(authToken, 'board', board.value) : api.clearAiMemory(authToken, 'board'),
                cls.value ? api.setAiMemory(authToken, 'class', cls.value) : api.clearAiMemory(authToken, 'class'),
                subject.value ? api.setAiMemory(authToken, 'subject', subject.value) : api.clearAiMemory(authToken, 'subject')
            ]);
            paint(true);
        } catch (e) {
            status.textContent = 'Could not save — try again';
        }
    }

    [board, cls, subject].forEach(el => el.addEventListener('change', save));

    // Restore whatever the tutor already remembers.
    async function load() {
        if (!authToken) return;
        try {
            const data = await api.getAiMemory(authToken);
            const facts = (data && data.facts) || [];
            const get = k => (facts.find(f => f.mem_key === k) || {}).mem_value || '';
            board.value = get('board');
            cls.value = get('class');
            subject.value = get('subject');
            paint(Boolean(board.value || cls.value));
        } catch (e) { /* non-fatal */ }
    }
    setTimeout(load, 2400);
})();

// Render LaTeX inside a chat bubble. KaTeX loads deferred, so this is
// defensive about it not being ready yet.
function renderChatMath(el) {
    if (!el || typeof renderMathInElement !== 'function') return;
    try {
        renderMathInElement(el, {
            delimiters: [
                { left: '$$', right: '$$', display: true },
                { left: '\\[', right: '\\]', display: true },
                { left: '$', right: '$', display: false },
                { left: '\\(', right: '\\)', display: false }
            ],
            ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
            throwOnError: false
        });
    } catch (e) { /* malformed LaTeX shouldn't break the message */ }
}

// ================================================================
// AI MARKDOWN + MATH
// ----------------------------------------------------------------
// Markdown and LaTeX fight each other: marked treats "_" as emphasis
// and eats backslashes, so "n_1\sin i" was reaching KaTeX already
// broken. Pull the math out first, render the markdown, then put the
// math back untouched and let KaTeX handle it.
// ================================================================
function renderAiMarkdown(text) {
    const src = String(text || '');
    if (typeof marked === 'undefined') {
        return `<p>${escapeHtml(src).replace(/\n/g, '<br>')}</p>`;
    }

    const math = [];
    const stash = (raw) => {
        math.push(raw);
        // Placeholder must survive markdown untouched: no punctuation it
        // could interpret, and inline so it doesn't break paragraphs.
        return `MATHPLACEHOLDER${math.length - 1}ENDMATH`;
    };

    // Order matters — display delimiters before inline ones.
    const protectedSrc = src
        .replace(/```[\s\S]*?```/g, (m) => stash(m))          // keep code fences verbatim too
        .replace(/\$\$([\s\S]+?)\$\$/g, (m) => stash(m))
        .replace(/\\\[([\s\S]+?)\\\]/g, (m) => stash(m))
        .replace(/\\\(([\s\S]+?)\\\)/g, (m) => stash(m))
        .replace(/\$(?!\s)([^\n$]+?)(?<!\s)\$/g, (m) => stash(m));

    let html = marked.parse(protectedSrc);
    html = html.replace(/MATHPLACEHOLDER(\d+)ENDMATH/g, (_, i) => {
        const raw = math[Number(i)] || '';
        // A stashed code fence still needs to become real markup.
        return raw.startsWith('```') ? marked.parse(raw) : raw;
    });
    return html;
}
