/* ================================================================
   STUDYHUB — PREMIUM INTERACTION LAYER
   ----------------------------------------------------------------
   Purely additive. Everything here is defensive: if an element the
   app expects isn't on the page, the feature simply doesn't install.
   ================================================================ */
(function () {
    'use strict';

    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function getAppShell() {
        return document.getElementById('app-container') ||
               document.querySelector('.app-wrapper') ||
               document.getElementById('app');
    }

    function ready(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn, { once: true });
        } else {
            fn();
        }
    }

    /* ------------------------------------------------------------
       1. Scroll-aware chrome
       The topbar and landing nav only grow a border/shadow once
       there is actually content sliding underneath them.
       ------------------------------------------------------------ */
    function installScrollChrome() {
        var main = document.querySelector('.main-content');
        var topbar = document.querySelector('.topbar');

        if (main && topbar) {
            var ticking = false;
            main.addEventListener('scroll', function () {
                if (ticking) return;
                ticking = true;
                requestAnimationFrame(function () {
                    topbar.classList.toggle('is-scrolled', main.scrollTop > 4);
                    ticking = false;
                });
            }, { passive: true });
        }

        // The landing nav's own scroll state is handled in landing.js (`.scrolled`).
    }

    /* ------------------------------------------------------------
       2. Reveal on scroll — LANDING PAGE ONLY.
       Inside the app, entry animation is done in CSS with a plain
       keyframe: an animation always finishes, so content can never
       get stranded at opacity 0 the way an observer-gated one can.
       ------------------------------------------------------------ */
    var revealObserver = null;

    var REVEAL_SELECTOR = [
        '#landing-page .feature-card',
        '#landing-page .tool-preview-card',
        '#landing-page .step-card',
        '#landing-page .land-section-head',
        '#landing-page .land-cta-inner'
    ].join(',');

    function installReveal() {
        if (reduceMotion || !('IntersectionObserver' in window)) return;

        revealObserver = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;
                entry.target.classList.add('pr-in');
                revealObserver.unobserve(entry.target);
            });
        }, { rootMargin: '0px 0px -6% 0px', threshold: 0.05 });

        scanForReveal();
    }

    function scanForReveal() {
        if (!revealObserver) return;
        var groups = {};
        document.querySelectorAll(REVEAL_SELECTOR).forEach(function (el) {
            if (el.dataset.prReveal) return;
            el.dataset.prReveal = '1';
            el.classList.add('pr-reveal');

            // Stagger siblings within the same parent so a grid cascades
            // instead of all popping at once.
            var key = el.parentElement ? (el.parentElement.className || 'root') : 'root';
            groups[key] = (groups[key] || 0) + 1;
            el.style.setProperty('--pr-delay', (Math.min(groups[key] - 1, 7) * 60) + 'ms');

            revealObserver.observe(el);

            // Safety net: nothing stays invisible for more than a moment,
            // whatever the observer decides.
            setTimeout(function () { el.classList.add('pr-in'); }, 2600);
        });
    }

    /* ------------------------------------------------------------
       3. Mobile tab bar
       Mirrors the five most-used sidebar destinations. Built from the
       real nav items so it can never drift out of sync with them.
       ------------------------------------------------------------ */
    var TAB_TARGETS = [
        { target: 'dashboard',  icon: 'fa-solid fa-border-all',           label: 'Home' },
        { target: 'ai-chat',    icon: 'fa-solid fa-wand-magic-sparkles',  label: 'AI' },
        { target: 'tools',      icon: 'fa-solid fa-toolbox',              label: 'Tools' },
        { target: 'classroom',  icon: 'fa-solid fa-graduation-cap',       label: 'Classes' },
        { target: 'profile',    icon: 'fa-solid fa-user',                 label: 'Profile' }
    ];

    function installTabBar() {
        var app = getAppShell();
        if (!app || document.querySelector('.pr-tabbar')) return;

        var bar = document.createElement('nav');
        bar.className = 'pr-tabbar';
        bar.setAttribute('aria-label', 'Primary');

        var inner = document.createElement('div');
        inner.className = 'pr-tabbar-inner';

        TAB_TARGETS.forEach(function (tab) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'pr-tab';
            btn.dataset.target = tab.target;
            btn.innerHTML = '<i class="' + tab.icon + '" aria-hidden="true"></i><span>' + tab.label + '</span>';
            btn.addEventListener('click', function () {
                goToSection(tab.target);
            });
            inner.appendChild(btn);
        });

        bar.appendChild(inner);
        document.body.appendChild(bar);
        syncTabBar();
    }

    function goToSection(target) {
        // Prefer the app's own router so gating/analytics still run.
        if (typeof window.navigateToSection === 'function') {
            window.navigateToSection(target, true);
        } else {
            var item = document.querySelector('.nav-item[data-target="' + target + '"]');
            if (item) item.click();
        }
        var main = document.querySelector('.main-content');
        if (main) main.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    }

    function syncTabBar() {
        var active = document.querySelector('.section-container.active');
        var id = active ? active.id : null;
        document.querySelectorAll('.pr-tab').forEach(function (tab) {
            tab.classList.toggle('active', tab.dataset.target === id);
            tab.setAttribute('aria-current', tab.dataset.target === id ? 'page' : 'false');
        });

        // The chat is a fixed-height workspace that docks its own composer,
        // so it must opt out of the scroll padding the other sections need
        // to clear the mobile tab bar.
        var main = document.querySelector('.main-content');
        if (main) main.classList.toggle('is-chat-view', id === 'ai-chat');
    }

    /* ------------------------------------------------------------
       4. Drawer polish
       Lock body scroll behind the open drawer and close it on Escape.
       ------------------------------------------------------------ */
    function installDrawer() {
        var sidebar = document.querySelector('.sidebar');
        var overlay = document.getElementById('sidebar-overlay');
        if (!sidebar) return;

        function close() {
            sidebar.classList.remove('open');
            if (overlay) overlay.classList.remove('active');
            document.body.style.removeProperty('overflow');
        }

        // Observe the class the app itself toggles rather than re-binding
        // the hamburger, so both code paths stay in agreement.
        new MutationObserver(function () {
            var open = sidebar.classList.contains('open');
            document.body.style.overflow = open ? 'hidden' : '';
        }).observe(sidebar, { attributes: true, attributeFilter: ['class'] });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && sidebar.classList.contains('open')) close();
        });
    }

    /* ------------------------------------------------------------
       5. Keep derived UI in sync when the app switches sections
       ------------------------------------------------------------ */
    function installSectionWatcher() {
        var main = document.querySelector('.main-content');
        if (!main) return;

        var pending = null;
        new MutationObserver(function () {
            clearTimeout(pending);
            pending = setTimeout(function () {
                syncTabBar();
                scanForReveal();
            }, 60);
        }).observe(main, {
            subtree: true,
            attributes: true,
            attributeFilter: ['class'],
            childList: true
        });
    }

    /* ------------------------------------------------------------
       6. Boot
       ------------------------------------------------------------ */
    ready(function () {
        installScrollChrome();
        installReveal();
        installDrawer();
        installTabBar();
        installSectionWatcher();

        // The app shell is toggled on login; mark the body so the tab bar
        // only reserves space while that shell is actually on screen.
        var app = getAppShell();
        var landing = document.getElementById('landing-page');
        if (app) {
            var mark = function () {
                var appVisible = getComputedStyle(app).display !== 'none';
                // The landing page and the app shell are mutually exclusive;
                // checking both survives stylesheets that force the shell visible.
                var landingVisible = landing && getComputedStyle(landing).display !== 'none';
                document.body.classList.toggle('pr-app-open', appVisible && !landingVisible);
            };
            mark();
            var opts = { attributes: true, attributeFilter: ['style', 'class'] };
            new MutationObserver(mark).observe(app, opts);
            if (landing) new MutationObserver(mark).observe(landing, opts);
        }
    });
})();
