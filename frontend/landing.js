// ============================================
// LANDING PAGE INTERACTIVITY
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    initParticles();
    initNavScroll();
    initCounters();
    initLandingButtons();
    initMobileMenu();
    initFeatureAnimations();
    initMarquee();
    initPasswordToggle();
});

// ---- Particle Canvas ----
function initParticles() {
    const canvas = document.getElementById('particle-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    let particles = [];
    let animFrame;
    let W, H;

    function resize() {
        W = canvas.width = window.innerWidth;
        H = canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    function Particle() {
        this.x = Math.random() * W;
        this.y = Math.random() * H;
        this.r = Math.random() * 2 + 0.5;
        this.vx = (Math.random() - 0.5) * 0.4;
        this.vy = (Math.random() - 0.5) * 0.4;
        this.alpha = Math.random() * 0.5 + 0.1;
        this.color = Math.random() > 0.5 ? '99,102,241' : '139,92,246';
    }

    function spawn(n) {
        particles = [];
        for (let i = 0; i < n; i++) particles.push(new Particle());
    }
    spawn(80);

    function draw() {
        ctx.clearRect(0, 0, W, H);
        particles.forEach(p => {
            p.x += p.vx; p.y += p.vy;
            if (p.x < 0) p.x = W;
            if (p.x > W) p.x = 0;
            if (p.y < 0) p.y = H;
            if (p.y > H) p.y = 0;

            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${p.color},${p.alpha})`;
            ctx.fill();
        });

        // Draw lines between nearby particles
        for (let i = 0; i < particles.length; i++) {
            for (let j = i + 1; j < particles.length; j++) {
                const dx = particles[i].x - particles[j].x;
                const dy = particles[i].y - particles[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 120) {
                    ctx.beginPath();
                    ctx.moveTo(particles[i].x, particles[i].y);
                    ctx.lineTo(particles[j].x, particles[j].y);
                    ctx.strokeStyle = `rgba(99,102,241,${0.06 * (1 - dist / 120)})`;
                    ctx.lineWidth = 0.8;
                    ctx.stroke();
                }
            }
        }
        animFrame = requestAnimationFrame(draw);
    }

    // Only show particles on landing page
    const landing = document.getElementById('landing-page');
    if (landing && landing.style.display !== 'none') {
        canvas.style.opacity = '1';
        draw();
    }

    window._showParticles = function() {
        canvas.style.opacity = '1';
        if (!animFrame) draw();
    };
    window._hideParticles = function() {
        canvas.style.opacity = '0';
        cancelAnimationFrame(animFrame);
        animFrame = null;
    };
}

// ---- Navbar scroll effect ----
function initNavScroll() {
    const nav = document.getElementById('land-nav');
    if (!nav) return;
    const onScroll = () => {
        nav.classList.toggle('scrolled', window.scrollY > 40);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
}

// ---- Animated counters ----
function initCounters() {
    const nums = document.querySelectorAll('.stat-num');
    if (!nums.length) return;

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const el = entry.target;
                const target = parseInt(el.dataset.target, 10);
                if (!Number.isFinite(target)) { observer.unobserve(el); return; }
                // The markup carries the real figure so an off-screen or
                // scriptless render never advertises "0 AI Tools"; the
                // count-up only rewinds once it is actually on screen.
                let start = 0;
                el.textContent = '0';
                const step = Math.ceil(target / 40);
                const interval = setInterval(() => {
                    start += step;
                    if (start >= target) { el.textContent = target; clearInterval(interval); }
                    else el.textContent = start;
                }, 30);
                observer.unobserve(el);
            }
        });
    }, { threshold: 0.5 });

    nums.forEach(n => observer.observe(n));
}

// ---- Landing CTA / Nav buttons ----
function initLandingButtons() {
    const loginIds = ['nav-login-btn', 'mobile-login-btn', 'hero-login-btn'];
    const signupIds = ['nav-signup-btn', 'mobile-signup-btn', 'hero-signup-btn', 'cta-signup-btn'];

    loginIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', () => openAuthModal('login'));
    });
    signupIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', () => openAuthModal('signup'));
    });

    // Smooth scroll for nav links
    document.querySelectorAll('.land-nav-links a, .land-mobile-link').forEach(a => {
        a.addEventListener('click', (e) => {
            const href = a.getAttribute('href');
            if (href && href.startsWith('#')) {
                e.preventDefault();
                const target = document.querySelector(href);
                if (target) target.scrollIntoView({ behavior: 'smooth' });
                // Close mobile menu
                const menu = document.getElementById('land-mobile-menu');
                if (menu) menu.classList.remove('open');
            }
        });
    });
}

// ---- Mobile menu ----
function initMobileMenu() {
    const btn = document.getElementById('land-hamburger');
    const menu = document.getElementById('land-mobile-menu');
    if (btn && menu) {
        btn.addEventListener('click', () => menu.classList.toggle('open'));
    }
}

// ---- Feature cards staggered fade-in ----
function initFeatureAnimations() {
    const cards = document.querySelectorAll('.feature-card');
    if (!cards.length) return;
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const delay = parseInt(entry.target.dataset.aos || '0', 10) * 80;
                setTimeout(() => {
                    entry.target.style.opacity = '1';
                    entry.target.style.transform = 'translateY(0)';
                }, delay);
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1 });

    cards.forEach(card => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(30px)';
        card.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
        observer.observe(card);
    });

    // Step cards too
    document.querySelectorAll('.step-card').forEach((card, i) => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(20px)';
        card.style.transition = `opacity 0.5s ${i * 0.1}s ease, transform 0.5s ${i * 0.1}s ease`;
        const obs = new IntersectionObserver((entries) => {
            entries.forEach(e => {
                if (e.isIntersecting) {
                    card.style.opacity = '1';
                    card.style.transform = 'translateY(0)';
                    obs.unobserve(card);
                }
            });
        }, { threshold: 0.2 });
        obs.observe(card);
    });
}

// ---- Marquee duplicate for seamless looping ----
function initMarquee() {
    // CSS handles the animation; we just ensure enough content
    // The HTML already has duplicate marquee-tracks
}

// ---- Password visibility toggle ----
function initPasswordToggle() {
    const toggleBtn = document.getElementById('toggle-pw');
    const pwInput = document.getElementById('password');
    if (toggleBtn && pwInput) {
        toggleBtn.addEventListener('click', () => {
            const isText = pwInput.type === 'text';
            pwInput.type = isText ? 'password' : 'text';
            toggleBtn.innerHTML = isText
                ? '<i class="fa-solid fa-eye"></i>'
                : '<i class="fa-solid fa-eye-slash"></i>';
        });
    }
}

// ---- Show/Hide landing page ----
window.showLanding = function() {
    const landing = document.getElementById('landing-page');
    const app = document.getElementById('app-container');
    if (landing) landing.style.display = 'block';
    if (app) app.style.display = 'none';
    document.body.style.overflow = '';
    if (window._showParticles) window._showParticles();
};

window.hideLanding = function() {
    const landing = document.getElementById('landing-page');
    if (landing) landing.style.display = 'none';
    document.body.style.overflow = 'hidden';
    if (window._hideParticles) window._hideParticles();
};

// ---- Open auth modal ----
window.openAuthModal = function(mode = 'login') {
    const modal = document.getElementById('auth-modal');
    if (!modal) return;
    modal.style.display = 'flex';

    const isLogin = mode !== 'signup';
    window.isLoginMode = isLogin;
    document.getElementById('auth-title').textContent = isLogin ? 'Welcome Back' : 'Create Account';
    document.getElementById('auth-subtitle').textContent = isLogin
        ? 'Log in to continue to your AI Study Hub'
        : 'Join the next-gen learning platform';
    const btn = document.getElementById('auth-btn-text');
    if (btn) btn.textContent = isLogin ? 'Log In' : 'Sign Up';
    document.getElementById('auth-switch-text').textContent = isLogin
        ? "Don't have an account?"
        : 'Already have an account?';
    document.getElementById('auth-switch-btn').textContent = isLogin ? 'Sign Up' : 'Log In';
    document.getElementById('auth-error').textContent = '';

    // Focus username
    setTimeout(() => document.getElementById('username')?.focus(), 100);
};

// Close auth modal when clicking close button
document.getElementById('auth-close-btn')?.addEventListener('click', () => {
    document.getElementById('auth-modal').style.display = 'none';
});

// SVG gradient for timer ring
(function injectTimerGradient() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.width = '0'; svg.style.height = '0'; svg.style.position = 'absolute';
    svg.innerHTML = `<defs>
        <linearGradient id="timerGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#4f46e5"/>
            <stop offset="100%" stop-color="#8b5cf6"/>
        </linearGradient>
    </defs>`;
    document.body.appendChild(svg);
})();
