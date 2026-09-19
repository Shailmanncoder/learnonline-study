/* ================================================================
   Verified Source Library — student cards
   ----------------------------------------------------------------
   Renders the `library` block of a Companion reply. Every field shown
   comes from the server's citation object, which is built from
   database records; a missing field is simply not shown, and an
   unverified record shows "Exact source not verified." instead of a
   source. Nothing here derives or formats a source on its own.
   ================================================================ */
window.SourceLibraryUI = (function () {
    const esc = (v) => String(v ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    // Links are server-validated already; refuse anything that is not https
    // anyway, so a bad record can never become a javascript: link.
    const safeHref = (url) => {
        try { const u = new URL(url); return u.protocol === 'https:' ? u.href : null; } catch (e) { return null; }
    };

    let seq = 0;

    function citationBlock(c) {
        if (!c || !c.verified) {
            return `<div class="vsl-source is-unverified" role="note">
                <span class="vsl-badge is-unverified"><i class="fa-solid fa-circle-question"></i> ${esc((c && c.message) || 'Exact source not verified.')}</span>
            </div>`;
        }
        const id = `vsl-details-${Date.now().toString(36)}-${++seq}`;
        const exact = c.exactPage && safeHref(c.exactPage.url);
        const original = c.original && safeHref(c.original.url);
        return `<div class="vsl-source">
            <span class="vsl-badge"><i class="fa-solid fa-circle-check"></i> ${esc(c.badge)}</span>
            <div class="vsl-title">${esc(c.title)}</div>
            ${c.line1 ? `<div class="vsl-line">${esc(c.line1)}</div>` : ''}
            ${c.line2 ? `<div class="vsl-line">${esc(c.line2)}</div>` : ''}
            ${c.line3 ? `<div class="vsl-line vsl-strong">${esc(c.line3)}</div>` : ''}
            <div class="vsl-actions">
                ${exact ? `<a class="vsl-btn" href="${esc(exact)}" target="_blank" rel="noopener noreferrer" title="${esc(c.exactPage.note || '')}"><i class="fa-solid fa-file-lines"></i> ${esc(c.exactPage.label)}</a>` : ''}
                ${!exact && original ? `<a class="vsl-btn" href="${esc(original)}" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square"></i> ${esc(c.original.label)}</a>` : ''}
                <button type="button" class="vsl-btn is-quiet" aria-expanded="false" aria-controls="${id}" data-vsl-toggle="${id}">
                    <i class="fa-solid fa-circle-info"></i> Source details
                </button>
            </div>
            ${exact && c.exactPage.note ? `<p class="vsl-note">${esc(c.exactPage.note)}</p>` : ''}
            <dl class="vsl-details" id="${id}" hidden>
                ${c.fields.map(f => `<dt>${esc(f.label)}</dt><dd>${
                    f.label === 'Official URL' && safeHref(f.value)
                        ? `<a href="${esc(safeHref(f.value))}" target="_blank" rel="noopener noreferrer">${esc(f.value)}</a>`
                        : esc(f.value)}</dd>`).join('')}
            </dl>
        </div>`;
    }

    function card(q) {
        const verified = q.citation && q.citation.verified;
        return `<article class="vsl-card">
            <div class="vsl-question">${esc(q.questionText).replace(/\n/g, '<br>')}</div>
            <div class="vsl-provenance">
                <span class="vsl-prov-label">Question source:</span>
                ${verified
                    ? `<span class="vsl-prov is-verified">✓ ${esc(q.citation.title)} — verified</span>`
                    : '<span class="vsl-prov is-unverified">Exact source not verified.</span>'}
            </div>
            ${q.recommendation ? `<div class="vsl-why"><strong>${esc(q.recommendation.label)}</strong> · ${q.recommendation.reasons.map(esc).join(' · ')}</div>` : ''}
            ${citationBlock(q.citation)}
        </article>`;
    }

    function render(res) {
        const lib = res && res.library;
        if (!lib) return '';
        const parts = [];
        if (lib.aiGenerated) {
            parts.push(`<div class="vsl-ai-banner"><span class="vsl-badge is-ai">✨ ${esc(lib.aiGenerated.label)}</span><p>${esc(lib.aiGenerated.note)}</p></div>`);
        }
        if (Array.isArray(lib.cards) && lib.cards.length) {
            parts.push(`<div class="vsl-list">${lib.cards.map(card).join('')}</div>`);
        }
        if (lib.answerSource === 'ai_generated') {
            parts.push('<p class="vsl-answer-source"><span class="vsl-prov-label">Answer source:</span> ✨ AI-generated explanation — not an official solution</p>');
        }
        return parts.length ? `<div class="vsl-block">${parts.join('')}</div>` : '';
    }

    function wire(root) {
        (root || document).querySelectorAll('[data-vsl-toggle]').forEach((btn) => {
            if (btn.dataset.vslWired) return;
            btn.dataset.vslWired = '1';
            btn.addEventListener('click', () => {
                const panel = document.getElementById(btn.dataset.vslToggle);
                if (!panel) return;
                panel.hidden = !panel.hidden;
                btn.setAttribute('aria-expanded', String(!panel.hidden));
            });
        });
    }

    // chatTools.js shows the same citation block under a worksheet question.
    return { render, wire, renderCitation: citationBlock };
})();
