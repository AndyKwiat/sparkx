// Balanced two-sided horizontal tree layout (MindMup style).
// sizes: Map<id, {w, h, top}>, where `top` = extra space reserved above the card for its sticker.
// Returns Map<id, {x, y, dir}> with x/y = card center, dir = +1 (right) / -1 (left) / 0 (root).

export const GAP_X = 64;
export const GAP_Y = 18;

export function layoutTree(root, sizes) {
  const pos = new Map();
  const memo = new Map();
  const box = (n) => {
    const s = sizes.get(n.id);
    return { w: s.w, h: s.h + s.top, top: s.top };
  };
  const visibleKids = (n) => (n.collapsed ? [] : n.children);
  const subH = (n) => {
    if (memo.has(n.id)) return memo.get(n.id);
    const own = box(n).h;
    const kids = visibleKids(n);
    let h = own;
    if (kids.length) {
      const sum = kids.reduce((a, k) => a + subH(k), 0) + GAP_Y * (kids.length - 1);
      h = Math.max(own, sum);
    }
    memo.set(n.id, h);
    return h;
  };

  const stack = (kids, dir, edgeX, cy, gapX) => {
    const hs = kids.map(subH);
    const total = hs.reduce((a, b) => a + b, 0) + GAP_Y * (kids.length - 1);
    let y = cy - total / 2;
    kids.forEach((k, i) => {
      place(k, dir, edgeX, y + hs[i] / 2, gapX);
      y += hs[i] + GAP_Y;
    });
  };

  const place = (n, dir, edgeX, cy, gapX = GAP_X) => {
    const b = box(n);
    const cx = edgeX + dir * (gapX + b.w / 2);
    const cardY = cy + b.top / 2; // card sits below its sticker area
    pos.set(n.id, { x: cx, y: cardY, dir });
    const kids = visibleKids(n);
    if (kids.length) stack(kids, dir, cx + (dir * b.w) / 2, cardY, GAP_X);
  };

  const rs = sizes.get(root.id);
  pos.set(root.id, { x: 0, y: 0, dir: 0 });
  const kids = visibleKids(root);
  const right = kids.filter((k) => k.side !== 'L');
  const left = kids.filter((k) => k.side === 'L');
  if (right.length) stack(right, 1, rs.w / 2, 0, GAP_X * 1.4);
  if (left.length) stack(left, -1, -rs.w / 2, 0, GAP_X * 1.4);
  return pos;
}
