// Shared keyboard behavior for the existing authentication and policy overlays.
(() => {
    const overlays = [...document.querySelectorAll('#auth-modal, #dev-auth-modal, #teacher-auth-modal, #legal-modal')];
    let active = null, previousFocus = null;
    const locked = new Map();
    const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const focusable = el => [...el.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]')].filter(x => !x.disabled && visible(x));
    function sync() {
        const next = overlays.find(visible) || null;
        if (next === active) return;
        for (const [el, value] of locked) el.inert = value;
        locked.clear();
        const old = active;
        active = next;
        if (next) {
            if (!old) previousFocus = document.activeElement;
            for (const child of document.body.children) {
                if (child !== next && !child.contains(next) && !['SCRIPT','LINK','STYLE'].includes(child.tagName)) {
                    locked.set(child, child.inert); child.inert = true;
                }
            }
            const input = next.querySelector('input:not([type="hidden"])');
            (input || focusable(next)[0] || next.querySelector('[role="dialog"]'))?.focus();
        } else if (previousFocus?.isConnected && visible(previousFocus)) previousFocus.focus();
    }
    overlays.forEach(el => new MutationObserver(sync).observe(el, {attributes:true,attributeFilter:['style','class']}));
    document.addEventListener('keydown', e => {
        if (!active) return;
        if (e.key === 'Escape') {e.preventDefault(); active.style.display='none'; sync();}
        if (e.key === 'Tab') {
            const items=focusable(active), first=items[0], last=items.at(-1);
            if (!first) {e.preventDefault();return;}
            if (!active.contains(document.activeElement) || (e.shiftKey && document.activeElement===first)) {e.preventDefault();(e.shiftKey?last:first).focus();}
            else if (!e.shiftKey && document.activeElement===last) {e.preventDefault();first.focus();}
        }
    },true);
    document.getElementById('refined-dev-entry')?.addEventListener('click',()=>document.getElementById('nav-dev-login-btn')?.click());
    for (const [button,input] of [['toggle-pw','password'],['dev-toggle-pw','dev-password'],['teacher-toggle-pw','teacher-password']]) {
        document.getElementById(button)?.addEventListener('click',()=>{
            document.getElementById(button).setAttribute('aria-label',document.getElementById(input).type==='password'?'Show password':'Hide password');
        });
    }
    const menu=document.getElementById('land-mobile-menu'), toggle=document.getElementById('land-hamburger');
    if(menu&&toggle) new MutationObserver(()=>toggle.setAttribute('aria-expanded',String(visible(menu)))).observe(menu,{attributes:true,attributeFilter:['class','style']});
    sync();
})();
