#!/usr/bin/env python3
"""Give an Ariadne agent Parallax's tools: add the `parallax` MCP server to its config.yaml.

Run it on the agent's machine, with a Python that has PyYAML:

    python3 add-parallax-to-ariadne.py --token-file /path/to/engine.token
        [--url http://127.0.0.1:13100/api/super/mcp]
        [--config ~/ariadne/config.yaml] [--name parallax] [--remove] [--dry-run]

The token file holds the same value as Parallax's SUPER_ENGINE_TOKEN. It is written into the
config file (which already holds the agent's other secrets) and is never printed.

What the entry does, in Ariadne's own terms:
  mcp_servers.<name>.enabled + transport: http + url   the server is dialled at boot and its
      tools join the tool deck as deferred tools.
  headers.Authorization                                  sent on every call; Ariadne compares
      the whole header against "Bearer <token>", so the value must match exactly.
  timeout                                                seconds for one call. Ariadne's default
      is 60, which cuts a generation off mid-flight, so it is set to 2100 here.
  max_bytes                                              the response body ceiling; Ariadne's
      default is 1 MiB and a generation result can carry more.
  instructions: verbatim                                 Parallax's own protocol text (the media
      order, the turn key) reaches the model as written. The default folds a server's instructions
      into the harness's retrieval contract, which would drop them.
  tool_search.always_load                              the Supercomputer's tools stay in the
      window every turn instead of sitting behind find(); without this the model can only reach
      them by searching for them.

Ariadne reads config.yaml once at boot, so restart the agent after this edit.

The edit is plain text, so the file's comments and layout stay as they are. A dated copy is kept
next to it, and the result is checked before it replaces the original: every other setting must
read back exactly as before.
"""
import argparse, os, re, shutil, sys, time

# The tools Supercomputer hands an engine. app_<slug> tools for connected apps are not listed:
# they come and go with the connections, and Ariadne's find() reaches them on its own.
SUPER_TOOLS = [
    "generate_media", "list_models", "get_model", "quote",
    "search_library", "get_asset",
    "computer_screenshot", "computer_click", "computer_type", "computer_key",
    "computer_scroll", "computer_open_page", "computer_shell",
    "list_connectors", "connect_app",
    "remember", "recall", "ask_user", "schedule_chat",
]
TIMEOUT = 2100      # seconds for one MCP call: a generation runs minutes
MAX_BYTES = 4_000_000

p = argparse.ArgumentParser()
p.add_argument('--config', default=os.path.expanduser('~/ariadne/config.yaml'))
p.add_argument('--url', default='http://127.0.0.1:13100/api/super/mcp')
p.add_argument('--token-file')
p.add_argument('--name', default='parallax')
p.add_argument('--no-always-load', action='store_true',
               help='leave the Supercomputer tools behind find() instead of in every turn')
p.add_argument('--remove', action='store_true')
p.add_argument('--dry-run', action='store_true', help='check the edit, change nothing')
a = p.parse_args()

try:
    import yaml
except ImportError:
    sys.exit('PyYAML is needed for the safety check.')
if not re.fullmatch(r'[a-z][a-z0-9_-]{0,30}', a.name):
    sys.exit('--name must be a short lower-case word')

block = []
if not a.remove:
    if not a.token_file:
        sys.exit('--token-file is required')
    token = open(a.token_file, encoding='utf-8').read().strip()
    if len(token) < 24 or not re.fullmatch(r'[A-Za-z0-9._~+/=-]+', token):
        sys.exit('the token must be 24 or more characters: letters, digits and . _ ~ + / = -')
    if not re.fullmatch(r'https?://[^\s"\x27#]+', a.url):
        sys.exit('--url must be an http(s) address')
    block = [
        f'  {a.name}:',
        '    enabled: true',
        '    transport: http',
        f'    url: "{a.url}"',
        '    headers:',
        f'      Authorization: "Bearer {token}"',
        # A generation runs minutes; Ariadne's 60-second default would cut it off mid-flight.
        f'    timeout: {TIMEOUT}',
        f'    max_bytes: {MAX_BYTES}',
        '    instructions: verbatim',
    ]

old = open(a.config, encoding='utf-8').read()
lines = old.split('\n')

def section(name):
    """Line range (start, end) of a top-level mapping, or None."""
    for i, l in enumerate(lines):
        if re.match(r'^' + name + r':\s*(#.*)?$', l):
            j = i + 1
            while j < len(lines) and (not lines[j].strip() or lines[j][0] in ' \t#'):
                j += 1
            return i, j
    return None

def entry_range(s, e):
    """Line range of an existing entry with our name inside the section, or None."""
    for i in range(s + 1, e):
        if re.match(r'^  ' + re.escape(a.name) + r':\s*(#.*)?$', lines[i]):
            j = i + 1
            while j < e and (not lines[j].strip() or re.match(r'^(   +|\t)', lines[j])):
                j += 1
            while j > i + 1 and not lines[j - 1].strip():
                j -= 1
            return i, j
    return None

def item_indent(s, e):
    """Where this file writes sequence items. A real config puts them at the same depth as the
    key (`  - name`); writing them deeper is not a style choice but a parse error, and the
    sections after the broken list -- `mcp_servers:` among them -- then read as nothing."""
    for i in range(s, e):
        m = re.match(r'^(\s*)- ', lines[i])
        if m:
            return m.group(1)
    for l in lines:
        m = re.match(r'^(\s{2,})- ', l)
        if m:
            return m.group(1)
    return '    '

sec = section('mcp_servers')
if sec:
    had = entry_range(*sec)
    if had:
        del lines[had[0]:had[1]]
    if not a.remove:
        lines[sec[0] + 1:sec[0] + 1] = block
elif not a.remove:
    if re.search(r'^mcp_servers:', old, re.M):
        sys.exit('mcp_servers is written in a form this script does not edit; add the entry by hand.')
    if lines and lines[-1].strip():
        lines.append('')
    lines += ['mcp_servers:'] + block + ['']

# ---- tool_search.always_load: the Supercomputer's tools in every turn ----
if not a.remove and not a.no_always_load:
    ts = section('tool_search')
    if ts is None:
        if lines and lines[-1].strip():
            lines.append('')
        lines += ['tool_search:', '  always_load:'] + [f'  - {n}' for n in SUPER_TOOLS] + ['']
    else:
        # Find the always_load list inside the section and add the names it does not have.
        at = None
        for i in range(ts[0] + 1, ts[1]):
            if re.match(r'^  always_load:\s*(#.*)?$', lines[i]):
                at = i
                break
        if at is None:
            ind = item_indent(ts[0] + 1, ts[1])
            lines[ts[0] + 1:ts[0] + 1] = ['  always_load:'] + [f'{ind}- {n}' for n in SUPER_TOOLS]
        else:
            ind = item_indent(at + 1, ts[1])
            j = at + 1
            have = []
            while j < ts[1] and re.match(r'^\s*- ', lines[j]):
                have.append(lines[j][lines[j].index('-') + 1:].strip().strip('"\''))
                j += 1
            add = [n for n in SUPER_TOOLS if n not in have]
            if add:
                lines[j:j] = [f'{ind}- {n}' for n in add]
elif a.remove:
    ts = section('tool_search')
    if ts:
        at = None
        for i in range(ts[0] + 1, ts[1]):
            if re.match(r'^  always_load:\s*(#.*)?$', lines[i]):
                at = i
                break
        if at is not None:
            j = at + 1
            while j < ts[1] and re.match(r'^    - ', lines[j]):
                if lines[j][lines[j].index('-') + 1:].strip().strip('"\'') in SUPER_TOOLS:
                    del lines[j]
                    ts = (ts[0], ts[1] - 1)
                else:
                    j += 1

new = '\n'.join(lines)
if new == old:
    print('nothing to change'); sys.exit(0)

before, after = yaml.safe_load(old) or {}, yaml.safe_load(new) or {}
b_servers, a_servers = dict(before.get('mcp_servers') or {}), dict(after.get('mcp_servers') or {})
b_servers.pop(a.name, None); mine = a_servers.pop(a.name, None)
rest = lambda d: {k: v for k, v in d.items() if k not in ('mcp_servers', 'tool_search')}
if rest(before) != rest(after):
    sys.exit('refusing: the edit would change other settings')
if b_servers != a_servers:
    sys.exit('refusing: the edit would change another MCP server')
if a.remove and mine is not None:
    sys.exit(f'refusing: {a.name} is still there')
if not a.remove and not (
    isinstance(mine, dict) and mine.get('url') == a.url and mine.get('timeout') == TIMEOUT
    and mine.get('enabled') is True and mine.get('transport') == 'http'
    and str((mine.get('headers') or {}).get('Authorization', '')).startswith('Bearer ')
):
    sys.exit(f'refusing: the {a.name} entry did not read back correctly')
if not a.remove and not a.no_always_load:
    loaded = (after.get('tool_search') or {}).get('always_load') or []
    missing = [n for n in SUPER_TOOLS if n not in loaded]
    if missing:
        sys.exit(f'refusing: always_load is missing {", ".join(missing)}')
    if isinstance(before.get('tool_search'), dict):
        # Names the operator put there for other reasons must survive exactly. The ones we
        # added are the only difference allowed.
        was = [n for n in (before['tool_search'].get('always_load') or []) if n not in SUPER_TOOLS]
        extra = [n for n in loaded if n not in SUPER_TOOLS]
        if extra != was:
            sys.exit('refusing: always_load changed a name that is not ours')

verb = 'remove' if a.remove else 'add'
if a.dry_run:
    print(f'dry run: would {verb} {a.name}; nothing changed'); sys.exit(0)

backup = f"{a.config}.before-{a.name}-{time.strftime('%Y%m%d-%H%M%S')}"
shutil.copy2(a.config, backup)
tmp = a.config + f'.{a.name}-tmp'
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as f:
    f.write(new)
shutil.copymode(a.config, tmp)
st = os.stat(a.config)
try:
    os.chown(tmp, st.st_uid, st.st_gid)
except PermissionError:
    pass
os.replace(tmp, a.config)
print(f"{'removed' if a.remove else 'added'} {a.name}; previous file kept as {backup}")
print('Ariadne reads config.yaml at boot: restart the agent for it to take effect.')
