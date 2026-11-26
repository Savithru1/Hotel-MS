/**
 * A short two-note chime for a new order. Built with the browser's own audio, so there is no
 * sound file to ship. A browser may refuse to play audio until the page has been clicked, and an
 * environment without audio must still work, so any failure here is deliberately silent: a
 * missing chime must never break the kitchen screen.
 */
export function playChime(): void {
  try {
    const AudioContextClass =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;

    const context = new AudioContextClass();
    const start = context.currentTime;
    for (const [index, frequency] of [880, 1175].entries()) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + index * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.25, start + index * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + index * 0.18 + 0.3);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + index * 0.18);
      oscillator.stop(start + index * 0.18 + 0.32);
    }
    window.setTimeout(() => void context.close(), 1000);
  } catch {
    // See above: audio is a nicety, never a requirement.
  }
}
