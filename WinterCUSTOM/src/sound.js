(function () {
  let ctx = null;
  let enabled = false;
  let volume = 0.7;

  function getCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone({ freq, endFreq, duration, type = 'sine', gain = 0.22, delay = 0 }) {
    if (!enabled || volume <= 0) return;
    const c = getCtx();
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const amp = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + duration);
    const peak = gain * volume;
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.012, duration * 0.3));
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(amp).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  const WGSound = {
    setEnabled(v) {
      enabled = !!v;
    },
    setVolume(pct) {
      volume = Math.max(0, Math.min(100, Number(pct) || 0)) / 100;
    },
    click() {
      tone({ freq: 620, endFreq: 480, duration: 0.07, type: 'triangle', gain: 0.18 });
    },
    hover() {
      tone({ freq: 900, duration: 0.03, type: 'sine', gain: 0.05 });
    },
    toggleOn() {
      tone({ freq: 520, endFreq: 900, duration: 0.11, type: 'triangle', gain: 0.2 });
    },
    toggleOff() {
      tone({ freq: 700, endFreq: 380, duration: 0.11, type: 'triangle', gain: 0.2 });
    },
    open() {
      tone({ freq: 420, endFreq: 720, duration: 0.16, type: 'sine', gain: 0.16 });
    },
    close() {
      tone({ freq: 560, endFreq: 320, duration: 0.14, type: 'sine', gain: 0.16 });
    },
    success() {
      tone({ freq: 660, endFreq: 660, duration: 0.1, type: 'triangle', gain: 0.22 });
      tone({ freq: 880, endFreq: 880, duration: 0.16, type: 'triangle', gain: 0.22, delay: 0.09 });
    },
    error() {
      tone({ freq: 300, endFreq: 220, duration: 0.2, type: 'sawtooth', gain: 0.16 });
    },
  };

  window.WGSound = WGSound;
})();
