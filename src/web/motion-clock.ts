/** Advance only persistent decorative animations, without a continuous CSS frame loop. */
export function startMotionClock() {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const interval = () => Math.max(200, Number(getComputedStyle(document.documentElement).getPropertyValue("--motion-step-ms")) || 500);
  const stop = () => { clearTimeout(timer); timer = undefined; };
  const tick = () => {
    timer = undefined;
    if (disposed || document.hidden || reduced.matches) return;
    const animations = document.getAnimations().filter(animation =>
      animation instanceof CSSAnimation && ["pulse", "spin"].includes(animation.animationName));
    if (!animations.length) return;
    const now = performance.now();
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = now;
    }
    timer = setTimeout(tick, interval());
  };
  const wake = () => {
    if (document.hidden || reduced.matches) stop();
    else if (!timer && !disposed) timer = setTimeout(tick, interval());
  };
  // Class/child changes discover newly mounted status indicators. No polling while idle.
  const observer = new MutationObserver(wake);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("resize", wake);
  reduced.addEventListener("change", wake);
  wake();
  return () => {
    disposed = true;
    stop();
    observer.disconnect();
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("resize", wake);
    reduced.removeEventListener("change", wake);
  };
}
