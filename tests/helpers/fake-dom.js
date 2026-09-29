// DOM minimal pour tester src/ui/dom.js sous Node (sans dépendance).

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(typeof node === 'string' ? new FakeText(node) : node);
  }

  removeChild(child) {
    this.childNodes = this.childNodes.filter((node) => node !== child);
    child.parentNode = null;
    return child;
  }

  replaceChildren(...nodes) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    this.replaceChildren(new FakeText(String(value)));
  }
}

class FakeText extends FakeNode {
  constructor(data) {
    super(3);
    this.data = data;
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value);
  }
}

class FakeElement extends FakeNode {
  constructor(tagName, namespaceURI = 'http://www.w3.org/1999/xhtml') {
    super(1);
    this.tagName = tagName.toUpperCase();
    this.localName = tagName;
    this.namespaceURI = namespaceURI;
    this.attributes = new Map();
    this.listeners = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  setAttributeNS(_ns, name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn({ type, target: this, ...event });
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }
}

export function createFakeDocument() {
  const document = {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (ns, tag) => new FakeElement(tag, ns),
    createTextNode: (data) => new FakeText(String(data)),
    getElementById: () => null,
    querySelectorAll: () => [],
  };
  document.head = new FakeElement('head');
  document.body = new FakeElement('body');
  return document;
}

/** Installe un faux document global le temps d'un test ; renvoie la fonction de restauration. */
export function installFakeDocument() {
  const previous = globalThis.document;
  const document = createFakeDocument();
  globalThis.document = document;
  return {
    document,
    restore() {
      if (previous === undefined) delete globalThis.document;
      else globalThis.document = previous;
    },
  };
}
