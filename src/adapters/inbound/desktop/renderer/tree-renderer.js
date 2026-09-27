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
  shield: '🛡',
  alert: '⚠',
  branch: '⑂',
  pause: '⏸',
  clock: '◷',
  document: '📄',
  gauge: '◔',
  info: 'ℹ',
  check: '✓',
  'check-circle': '✓',
  play: '▶',
  stop: '■',
  mic: '🎙',
  'mic-off': '⌀',
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
  /* history view (issue #221) */
  HistoryView: 'history-view',
  HistorySection: null, // header line added below, rows follow directly
  HistoryDecisionRow: 'taskrow',
  HistoryDecisionKind: 'obj',
  HistoryDecisionMeta: 'stat',
  HistorySearchResults: 'history-search-results',
  /* settings memory/rules browse (issue #223) */
  MemorySettingsView: 'memory-settings',
  MemoryFilterBar: 'pref-form',
  MemoryFilterChip: 'chip',
  MemoryRow: 'card',
  MemoryStatement: 'title',
  MemoryMeta: 'actions',
  MemoryActions: 'actions',
  /* session inspector (issue #126) */
  Inspector: 'cols',
  InspectorCol: 'col',
  InspRow: 'row',
  InspRowTitle: null, // <b>
  InspRowSub: 't',
  DetailMono: 'mono',
  FidelityNotice: 'fidelity',
  /* fleet/quota screen (issue #127) */
  FleetView: 'fleet-view',
  FleetCard: 'card',
  FleetTop: 'top',
  FleetProvider: 'kind',
  FleetSummary: 'summary',
  FleetRow: 'taskrow',
  Chip: 'chip',
  Bar: null, // handled specially (bar + inner fill)
  /* preferences screen (issue #128) */
  PrefsView: 'prefs-view',
  PrefCard: 'card',
  PrefTop: 'top',
  PrefKind: 'kind mono',
  PrefNote: 'summary',
  PrefMeta: 'meta',
  PrefActions: 'actions',
  PrefAddBar: 'pref-addbar',
  Button: null, // <button>
  ClearAllButton: null,
  ActionButton: null,
  Icon: 'icon',
  /* chat screen (issue #160) — the single Secretary thread */
  ChatView: 'chatlist',
  ChatMsg: 'msg',
  ChatWho: 'who',
  ToolRow: 'toolrow',
  ToolStatus: null, // <span>
  ClearRow: 'clearrow',
  /* failed send row (issue #263) — toolrow family, red accent */
  SendErrorRow: 'senderror',
  WorkRow: 'workrow',
  WorkDot: 'dot wait',
  /* chat activity/diff drawer (issue #181) */
  ActivityDrawerList: null, // plain div — layout owned by #chatDrawerList
  /* Settings > Repos (issue #253) */
  ReposView: 'repos-view',
  ReposAddRow: 'pref-addbar',
  ReposRootsSection: 'repos-roots',
  ReposRootRow: 'taskrow',
  ReposRootPriority: 'n',
  ReposRootPath: 'obj mono',
  ReposRootActions: 'actions',
  ReposRepoList: 'repos-repo-list',
  ReposRepoRow: 'card',
  ReposRepoName: 'title',
  ReposRepoPath: 'summary mono',
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
  const isButton = tag === 'Button' || tag === 'ClearAllButton' || tag === 'ActionButton';
  const el = document.createElement(
    isButton
      ? 'button'
      : tag === 'Icon' || tag === 'ToolStatus' || tag === 'WorkDot'
        ? 'span'
        : tag === 'InspRowTitle'
          ? 'b'
          : 'div',
  );

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
  // Shared confirm gate (issue #261): views attach `confirm: '<prompt>'`
  // to journaled/destructive commands; the dispatcher prompts via native
  // confirm() and a cancel sends nothing. Supersedes #224's
  // confirmPromote flag (same text, generic mechanism).
  if (props && props.confirm) el.dataset.confirm = String(props.confirm);
  // Stable identity for entrance-animation diffing (chat messages) — the
  // renderer decides what's "new since last render", never the tree.
  if (props && props.id !== undefined) el.dataset.id = String(props.id);
  if (tag === 'ChipClear') el.style.cursor = 'pointer';
  if (tag === 'InboxItem' || tag === 'TaskRow' || (props && props.selectable)) {
    el.dataset.selectable = 'true';
    el.style.cursor = 'pointer';
  }

  /* --- settings memory/rules browse (issue #223) --- */
  if (tag === 'MemoryRow' && props) {
    if (props.scope !== undefined) el.dataset.scope = String(props.scope);
    if (props.kind !== undefined) el.dataset.kind = String(props.kind);
  }
  if (tag === 'MemoryFilterChip' && props) {
    el.dataset.filterKind = String(props.filterKind || '');
    el.dataset.value = String(props.value || '');
    el.style.cursor = 'pointer';
    if (props.value === '') el.classList.add('active');
  }

  /* --- history view section header (issue #221) --- */
  if (tag === 'HistorySection' && props && props.title) {
    const head = document.createElement('div');
    head.className = 'sect';
    head.textContent = String(props.title);
    el.appendChild(head);
  }

  /* --- session inspector rows (issue #126) --- */
  if (tag === 'InspectorCol' && props && props.title) {
    const head = document.createElement('div');
    head.className = 'colhead';
    head.textContent = String(props.title);
    el.appendChild(head);
  }
  if (tag === 'InspRow') {
    if (props && props.selected) el.classList.add('sel');
    if (props && props.muted) el.classList.add('cond');
  }
  if (tag === 'InspRowTitle' && props && props.color) {
    const c = { error: 'red', warn: 'amber', success: 'green', info: 'slate' }[props.color];
    if (c) el.style.color = 'var(--' + c + ')';
  }
  if (tag === 'DetailMono') el.style.whiteSpace = 'pre-wrap';

  /* --- fleet/quota bar (issue #127): <div class="bar"><i style="width:N%"></i></div> --- */
  if (tag === 'Bar') {
    el.classList.add('bar');
    const fill = document.createElement('i');
    fill.style.width = String(props && props.pct ? props.pct : 0) + '%';
    if (props && props.dry) fill.classList.add('dry');
    if (props && props.warm) fill.classList.add('warm');
    el.appendChild(fill);
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
