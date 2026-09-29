// Vérificateur minimal de XML bien formé (suffisant pour les SVG générés).
// → { root, elements: [{ name, attrs }] } ; lève une erreur si le document est mal formé.

const NAME = '[A-Za-z_][A-Za-z0-9_.:-]*';
const ATTR_RE = new RegExp(`\\s+(${NAME})\\s*=\\s*("([^"<]*)"|'([^'<]*)')`, 'y');
const ENTITY_RE = /&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/;

export function parseXml(xml) {
  let i = 0;
  const stack = [];
  const elements = [];
  let root = null;
  const fail = (msg) => { throw new Error(`XML mal formé (position ${i}) : ${msg}`); };

  if (xml.startsWith('<?xml')) {
    const end = xml.indexOf('?>');
    if (end < 0) fail('déclaration XML non fermée');
    i = end + 2;
  }
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const text = xml.slice(i, lt < 0 ? xml.length : lt);
    if (ENTITY_RE.test(text)) fail('esperluette non échappée dans le texte');
    if (text.trim() && stack.length === 0) fail('texte hors de l\'élément racine');
    if (lt < 0) break;
    i = lt;
    if (xml.startsWith('</', i)) {
      const m = new RegExp(`^</(${NAME})\\s*>`).exec(xml.slice(i));
      if (!m) fail('balise fermante invalide');
      const open = stack.pop();
      if (open !== m[1]) fail(`fermeture de <${m[1]}> alors que <${open}> est ouvert`);
      i += m[0].length;
      continue;
    }
    const m = new RegExp(`^<(${NAME})`).exec(xml.slice(i));
    if (!m) fail('balise ouvrante invalide');
    if (stack.length === 0 && root) fail('plusieurs éléments racines');
    const name = m[1];
    i += m[0].length;
    const attrs = {};
    for (;;) {
      ATTR_RE.lastIndex = i;
      const a = ATTR_RE.exec(xml);
      if (!a) break;
      if (Object.hasOwn(attrs, a[1])) fail(`attribut ${a[1]} en double`);
      const value = a[3] ?? a[4];
      if (ENTITY_RE.test(value)) fail(`esperluette non échappée dans ${a[1]}`);
      attrs[a[1]] = value;
      i = ATTR_RE.lastIndex;
    }
    const close = /^\s*(\/?)>/.exec(xml.slice(i));
    if (!close) fail(`fin de balise <${name}> invalide`);
    i += close[0].length;
    if (!root) root = name;
    elements.push({ name, attrs });
    if (!close[1]) stack.push(name);
  }
  if (stack.length) fail(`éléments non fermés : ${stack.join(', ')}`);
  if (!root) fail('aucun élément');
  return { root, elements };
}
