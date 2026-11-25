// The spinning wheel. Purely visual: it is handed the server's predetermined
// recipient and always comes to rest on that name.
import { reducedMotion } from './common.js';

const COLORS = [
  { fill: '#16423c', text: '#ffffff' },
  { fill: '#b3253f', text: '#ffffff' },
  { fill: '#f3f6f2', text: '#16423c' },
  { fill: '#c9a227', text: '#1b2421' },
];

export class Wheel {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.names = [];
    this.rotation = 0;
  }

  setNames(names) {
    // Need at least a few slices for it to look like a wheel.
    let list = names.slice();
    while (list.length < 6) list = list.concat(names);
    this.names = list;
    this.draw();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const size = this.canvas.clientWidth || 320;
    this.canvas.width = Math.round(size * dpr);
    this.canvas.height = Math.round(size * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.size = size;
    this.draw();
  }

  draw() {
    const { ctx, names } = this;
    const size = this.size || this.canvas.clientWidth || 320;
    const r = size / 2;
    ctx.clearRect(0, 0, size, size);
    if (!names.length) return;
    const seg = (Math.PI * 2) / names.length;
    const fontSize = Math.max(11, Math.min(18, (r * 0.9) / Math.max(6, names.length * 0.55)));

    ctx.save();
    ctx.translate(r, r);
    ctx.rotate(this.rotation);
    names.forEach((name, i) => {
      const c = COLORS[i % COLORS.length];
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r - 6, i * seg, (i + 1) * seg);
      ctx.closePath();
      ctx.fillStyle = c.fill;
      ctx.fill();
      ctx.strokeStyle = '#0e2e2a';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.save();
      ctx.rotate((i + 0.5) * seg);
      ctx.fillStyle = c.text;
      ctx.font = `700 ${fontSize}px 'Atkinson Hyperlegible', system-ui, sans-serif`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const label = name.length > 16 ? name.slice(0, 15) + '…' : name;
      ctx.fillText(label, r - 20, 0);
      ctx.restore();
    });
    ctx.restore();

    // Rim and hub
    ctx.beginPath();
    ctx.arc(r, r, r - 4, 0, Math.PI * 2);
    ctx.strokeStyle = '#0e2e2a';
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(r, r, r * 0.12, 0, Math.PI * 2);
    ctx.fillStyle = '#c9a227';
    ctx.fill();
    ctx.strokeStyle = '#0e2e2a';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Spin so that a slice showing `target` stops under the pointer (top).
  spinTo(target, { duration = 5200 } = {}) {
    const idxs = this.names.map((n, i) => (n === target ? i : -1)).filter((i) => i >= 0);
    if (!idxs.length) {
      this.names.splice(Math.floor(Math.random() * this.names.length), 1, target);
      return this.spinTo(target, { duration });
    }
    const i = idxs[Math.floor(Math.random() * idxs.length)];
    const seg = (Math.PI * 2) / this.names.length;
    const jitter = (Math.random() - 0.5) * seg * 0.6;
    const base = -Math.PI / 2 - (i + 0.5) * seg + jitter;
    const TAU = Math.PI * 2;
    const start = this.rotation;
    const turns = reducedMotion() ? 0 : 7;
    let end = base;
    while (end < start + turns * TAU) end += TAU;

    if (reducedMotion()) {
      this.rotation = end;
      this.draw();
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const t0 = performance.now();
      const ease = (t) => 1 - Math.pow(1 - t, 4);
      const step = (now) => {
        const t = Math.min(1, (now - t0) / duration);
        this.rotation = start + (end - start) * ease(t);
        this.draw();
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }
}
