(function(window, document) {
  'use strict';
  const DEFAULTS = { color: 'rgba(0,0,0,0.15)', duration: 600, scale: 2.5, padding: 0 };
  function getOption(elem, name, parseFn, fallback) {
    const attr = elem.getAttribute(name);
    if (attr == null) return fallback;
    return parseFn ? parseFn(attr) : attr;
  }
  function createRippleElement(size, color, duration) {
    const span = document.createElement('span');
    span.className = 'attr-ripple';
    span.style.width = span.style.height = size + 'px';
    span.style.background = color;
    span.style.animationDuration = duration + 'ms';
    return span;
  }
  function applyRipple(elem, clientX, clientY) {
    const color = getOption(elem, 'data-ripple-color', null, DEFAULTS.color);
    const duration = getOption(elem, 'data-ripple-duration', (v) => parseInt(v,10)||DEFAULTS.duration, DEFAULTS.duration);
    const scale = getOption(elem, 'data-ripple-scale', (v) => parseFloat(v)||DEFAULTS.scale, DEFAULTS.scale);
    const centered = elem.hasAttribute('data-ripple-centered');
    const padding = getOption(elem, 'data-ripple-padding', (v)=>parseInt(v,10)||0, DEFAULTS.padding);
    const rect = elem.getBoundingClientRect();
    const maxDim = Math.max(rect.width, rect.height);
    const size = Math.ceil(maxDim * scale) + padding;
    const ripple = createRippleElement(size, color, duration);
    ripple.style.position = 'absolute';
    ripple.style.borderRadius = '50%';
    ripple.style.pointerEvents = 'none';
    ripple.style.transform = 'scale(0)';
    ripple.style.opacity = '1';
    let x, y;
    if (centered) {
      x = rect.width / 2 - size / 2;
      y = rect.height / 2 - size / 2;
    } else {
      x = clientX - rect.left - size / 2;
      y = clientY - rect.top - size / 2;
    }
    ripple.style.left = x + 'px';
    ripple.style.top = y + 'px';
    const computedStyle = window.getComputedStyle(elem);
    if (computedStyle.position === 'static') {
      elem.style.position = 'relative';
    }
    elem.style.overflow = 'hidden';
    elem.appendChild(ripple);
    requestAnimationFrame(() => {
      ripple.style.transition = `transform ${duration}ms cubic-bezier(.4,0,.2,1), opacity ${duration}ms linear`;
      ripple.style.transform = 'scale(1)';
      ripple.style.opacity = '0';
    });
    setTimeout(() => { try { ripple.remove(); } catch(e){} }, duration + 50);
  }
  function pointerHandler(e) {
    const target = e.target.closest && e.target.closest('[data-ripple]');
    if (!target) return;
    let clientX = (e.touches && e.touches[0] && e.touches[0].clientX) || e.clientX;
    let clientY = (e.touches && e.touches[0] && e.touches[0].clientY) || e.clientY;
    applyRipple(target, clientX, clientY);
  }
  function init() {
    document.addEventListener('mousedown', pointerHandler, {passive: true});
    document.addEventListener('touchstart', pointerHandler, {passive: true});
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
  window.AttrRipple = { apply: applyRipple };
})(window, document);
