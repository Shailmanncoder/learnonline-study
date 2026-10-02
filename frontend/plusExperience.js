(() => {
    'use strict';
    const catalog = window.plusCatalog;
    if (!catalog) return;
    const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    const money = value => new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', maximumFractionDigits:0 }).format(value);
    const plans = ['student', 'developer'];
    document.querySelectorAll('.plus-sidebar-button[data-plus-open]').forEach(button => {
        const plan = catalog[button.dataset.plusOpen];
        if (plan) button.querySelector('small').textContent = `${money(plan.price)}/mo ↗`;
    });
    const cards = document.getElementById('plus-plan-cards');
    cards.innerHTML = plans.map(key => {
        const p = catalog[key];
        return `<article class="plus-card"><span class="plus-eyebrow">${p.eyebrow}</span><h3>${p.name}</h3><p>${p.description}</p><div class="plus-price">${money(p.price)}<span>/ month</span></div><button class="plus-primary" data-plus-open="${key}">See every feature <span aria-hidden="true">↗</span></button><ul>${p.highlights.map(item=>`<li>${esc(item)}</li>`).join('')}</ul></article>`;
    }).join('');
    const dialog = document.getElementById('plus-dialog');
    const content = document.getElementById('plus-dialog-content');
    let returnFocus;
    function render(key) {
        const p = catalog[key] || catalog.student;
        dialog.dataset.plan = key;
        document.getElementById('plus-dialog-title').textContent = p.name;
        document.getElementById('plus-dialog-price').textContent = `${money(p.price)} / month`;
        const featureGroups = p.groups.map(group => `<section class="plus-feature-group"><h3>${esc(group.name)}</h3><dl>${group.items.map(([name,detail])=>`<div><dt>${esc(name)}</dt><dd>${esc(detail)}</dd></div>`).join('')}</dl></section>`).join('');
        let tools = '';
        if (key === 'student' && typeof toolsData !== 'undefined') {
            const categories = [...new Set(toolsData.map(t => t.category))];
            tools = `<section class="plus-feature-group plus-tool-catalog"><h3>All ${toolsData.length} AI tools</h3><p>Every tool in the current collection, grouped by what you want to do.</p>${categories.map(category => `<details><summary>${esc(category)} <span>${toolsData.filter(t=>t.category===category).length} tools</span></summary><dl>${toolsData.filter(t=>t.category===category).map(t=>`<div><dt>${esc(t.name)}</dt><dd>${esc(t.desc)}</dd></div>`).join('')}</dl></details>`).join('')}</section>`;
        }
        content.innerHTML = `<p class="plus-intro">${esc(p.description)}</p>${featureGroups}${tools}<aside class="plus-availability"><strong>Before subscribing</strong><p>Review the final price, tax and payment terms at checkout. One month at a time, with manual renewal. Sandbox checkout is clearly labelled and does not charge money. Existing free workspace tools stay available.</p><p>AI and search features depend on service availability. File limits vary by tool. Review generated answers and code before using them.</p></aside><a class="plus-primary plus-enquiry" href="/checkout?plan=${key}">Continue to checkout <span aria-hidden="true">↗</span></a>`;
        document.querySelectorAll('[data-plus-plan]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.plusPlan === key)));
        content.scrollTop = 0;
    }
    document.addEventListener('click', event => {
        const trigger = event.target.closest('[data-plus-open]');
        if (!trigger) return;
        returnFocus = trigger;
        render(plans.includes(trigger.dataset.plusOpen) ? trigger.dataset.plusOpen : 'student');
        if (!dialog.open) dialog.showModal();
        document.body.classList.add('plus-dialog-open');
    });
    document.querySelectorAll('[data-plus-plan]').forEach(button => button.addEventListener('click', () => render(button.dataset.plusPlan)));
    document.getElementById('plus-dialog-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => { document.body.classList.remove('plus-dialog-open'); returnFocus?.focus(); });

    // Keep all study controls available, while making the first view quieter.
    const stream = document.getElementById('grok-welcome-view');
    const syllabus = document.getElementById('grok-syllabus-bar');
    if (stream && syllabus) {
        const details = document.createElement('details');
        details.className = 'plus-study-settings';
        const summary = document.createElement('summary');
        summary.textContent = 'Personalise your study context';
        syllabus.before(details); details.append(summary, syllabus);
    }
    document.querySelectorAll('#developer-portal-container .devhub-test-config-card').forEach(card => {
        const note = document.createElement('p'); note.className = 'plus-auto-note';
        note.innerHTML = '<span aria-hidden="true">✦</span> Auto selects a model for this task';
        card.prepend(note);
    });
})();
