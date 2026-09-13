/**
 * RenderTree → DOM walker (DG-01, issue #119).
 *
 * The view layer emits framework-agnostic `{ tag, props, children }` trees;
 * this walker projects them onto DOM nodes. Semantic tags map to token-class
 * elements; unknown tags degrade to a plain div with a `t-<tag>` class so
 * new view components render acceptably before getting dedicated styling.
 *
 * Commands: `props.command` string identifiers become `data-command`
 * attributes; a delegated click listener calls `window.florina.command(cmd)`
 * which the preload routes to the daemon via the main process.
 */

const ICONS = {
  shield: '🛡', alert: '⚠', branch: '⑂', pause: '⏸', clock: '◷',
  document: '📄', gauge: '◔', info: 'ℹ', check: '✓', 'check-circle': '✓',
  play: '▶', stop: '■', mic: '🎙', 'mic-off': '⌀',
};

const TAG_CLASS = {
  HomeView: 'home-view',
  SectionHeader: 'sect',
  SectionCount: 'n',
  TaskRow: 'taskrow',
  TaskObjective: 'obj',
  ProviderChip: 'chip',
  StatusWord: 'stat',
  InboxList: 'inbox-list',
  PriorityGroup: 'pgroup',
  GroupHeader: 'sect',
  GroupLabel: 'sect-label',
  GroupCount: 'n',
  GroupItems: 'group-items',
  InboxItem: 'card',
  ItemHeader: 'top',
  PriorityLabel: 'chip',
  KindLabel: 'kind',
  ItemTitle: 'title',
  ItemSummary: 'summary',
  ItemActions: 'actions',
  EmptyState: 'empty',
  EmptyTitle: 'empty-big',
  EmptyHint: 'empty-hint',
  FilterBar: 'filter-bar',
  FilterLabel: 'sect-label',
  FilterChip: 'chip',
  ChipClear: 'chip-clear',
  Button: null, // <button>
  ClearAllButton: null,
  ActionButton: null,
  Icon: 'icon',
};

function propsToClass(tag, props) {
  const cls = [];
  const base = TAG_CLASS[tag];
  if (base) cls.push(base);
  else if (base === undefined) cls.push('t-' + tag.toLowerCase());
  if (props) {
    if (props.priority) cls.push(String(props.priority));
    if (props.color && TAG_CLASS[tag] !== 'chip') cls.push('c-' + props.color);
    if (props.color && tag === 'PriorityLabel') cls.push(String(props.priority || props.color));
    if (props.variant) cls.push(String(props.variant));
    if (props.weight === 'bold' || props.weight === 'semibold') cls.push('w-' + props.weight);
    if (props.spacing) cls.push('sp-' + props.spacing);
  }
  return cls.join(' ');
}

function renderNode(node) {
  if (typeof node === 'string') return document.createTextNode(node);
  const { tag, props, children } = node;
  const isButton =
    tag === 'Button' || tag === 'ClearAllButton' || tag === 'ActionButton';
  const el = document.createElement(isButton ? 'button' : tag === 'Icon' ? 'span' : 'div');

  const cls = propsToClass(tag, props || {});
  if (cls) el.className = cls;

  if (tag === 'Icon' && props && props.name) {
    el.textContent = ICONS[props.name] || '·';
    if (props.color) el.style.color = 'var(--' + props.color + ')';
  }
  if (isButton) {
    if (props && props.variant === 'danger') el.classList.add('danger');
    else if (props && props.variant === 'ghost') el.classList.add('ghost');
  }
  if (props && props.command) el.dataset.command = String(props.command);
  if (tag === 'ChipClear') el.style.cursor = 'pointer';
  if (tag === 'InboxItem' || tag === 'TaskRow') {
    el.dataset.selectable = 'true';
    el.style.cursor = 'pointer';
  }
  if (tag === 'SectionHeader' && props && props.label) {
    const label = document.createElement('span');
    label.className = 'sect-label';
    label.textContent = String(props.label);
    el.appendChild(label);
  }

  for (const child of children || []) el.appendChild(renderNode(child));
  return el;
}

/** Replace `container`'s content with the rendered tree. */
export function mount(tree, container) {
  container.replaceChildren(renderNode(tree));
}
