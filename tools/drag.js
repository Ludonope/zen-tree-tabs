// Dev only: simulate dragging tab `args.src` onto tab `args.dst` at vertical
// fraction `args.frac` (0 = top edge, 1 = bottom edge) through Zen's real
// drag-and-drop handlers. Usage (from marionette eval):
//   const args = {src: "a1", dst: "b", frac: 0.5}; <this file>
const T = l => gBrowser.tabs.find(t => t.label == l);
const wait = ms => new Promise(r => setTimeout(r, ms));
const src = T(args.src), dst = T(args.dst);
const dt = new DataTransfer();
const at = (el, frac) => {
  const r = el.getBoundingClientRect();
  const clientX = r.left + 60, clientY = r.top + r.height * frac;
  return { clientX, clientY, screenX: window.mozInnerScreenX + clientX, screenY: window.mozInnerScreenY + clientY };
};
const fire = (el, type, frac) =>
  el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...at(el, frac) }));
fire(src, "dragstart", 0.5);
dt.dropEffect = "move";
await wait(50);
for (const f of [0.5, 0.6, 0.9, 0.3, args.frac]) {
  fire(dst, "dragover", f);
  await wait(30);
}
const state = {
  dropTarget: document.querySelector("[ztt-drop-target]")?.label ?? null,
  zenDropElement: src._dragData?.dropElement?.label,
  zenDropBefore: src._dragData?.dropBefore,
};
fire(dst, "drop", args.frac);
fire(src, "dragend", args.frac);
await wait(600);
state.result = gBrowser.tabs.filter(t => !t.hasAttribute("zen-empty-tab")).map(t => `${"  ".repeat(+t.getAttribute("ztt-depth") || 0)}${t.label}`).join(" , ");
return state;
