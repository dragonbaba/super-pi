import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

export function animationGolden(Armin: any) {
 const originalRandom = Math.random;
 const values = [];
 try {
  for (const effect of ["typewriter", "scanline", "rain", "fade", "crt", "glitch", "dissolve"]) {
   let seed = 123456789;
   Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
   const component = new Armin({ requestRender() {} });
   try {
    component.stopAnimation(); component.effect = effect; component.currentGrid = component.createEmptyGrid(); component.effectState = {}; component.initEffect();
    const hash = createHash("sha256"); let ticks = 0;
    for (; ticks < 220; ticks++) {
     const done = component.tickEffect(); component.updateDisplay();
     for (const width of [0, 12, 40]) hash.update(JSON.stringify(component.render(width).map(stripVTControlCharacters)));
     if (done) { ticks++; break; }
    }
    values.push({ effect, ticks, hash: hash.digest("hex") });
   } finally { component.dispose(); }
   if (component.ui !== null || component.interval !== null || component.cachedLines.length !== 0) throw new Error("animation owner retained");
  }
 } finally { Math.random = originalRandom; }
 return values;
}
