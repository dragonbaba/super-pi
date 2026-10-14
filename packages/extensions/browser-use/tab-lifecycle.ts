/** Generated once per admitted browser call, never on progress/render paths.
 * The workspace owns at most eight target IDs. Persist before attach/navigation
 * so a later script failure cannot lose a successfully created target. */
export function ownedTabsPrelude(statePath: string): string {
  return `
import json as _pi_json
import os as _pi_os
from pathlib import Path as _pi_Path
_pi_tab_file = _pi_Path(${JSON.stringify(statePath.replaceAll("\\", "/"))})
_pi_tabs = {}
if _pi_tab_file.exists():
    if _pi_tab_file.stat().st_size > 8192:
        raise RuntimeError("[BROWSER_TABS_STATE] Oversized tab state; no browser actions executed")
    _pi_tabs = _pi_json.loads(_pi_tab_file.read_text(encoding="utf-8"))
    if not isinstance(_pi_tabs, dict) or len(_pi_tabs) > 8 or any(
        not isinstance(k, str) or len(k) > 128 or not isinstance(v, str) or len(v) > 32
        for k, v in _pi_tabs.items()
    ):
        raise RuntimeError("[BROWSER_TABS_STATE] Invalid tab state; no browser actions executed")

def _pi_save_tabs():
    temporary = _pi_tab_file.with_suffix(".tmp")
    temporary.write_text(_pi_json.dumps(_pi_tabs), encoding="utf-8")
    _pi_os.replace(temporary, _pi_tab_file)

def _pi_live_tabs():
    live = {tab["targetId"]: tab for tab in list_tabs()}
    stale = [target for target in _pi_tabs if target not in live]
    for target in stale:
        del _pi_tabs[target]
    if stale:
        _pi_save_tabs()
    return live

def _pi_create_tab(url, role):
    if len(_pi_tabs) >= 8:
        raise RuntimeError("[BROWSER_TABS_LIMIT] Eight task tabs are open; reuse open_tab or close an owned tab")
    target = cdp("Target.createTarget", url="about:blank", background=True)["targetId"]
    _pi_tabs[target] = role
    try:
        _pi_save_tabs()
    except BaseException:
        # Only this just-created target may be rolled back. Never retry creation.
        cdp("Target.closeTarget", targetId=target)
        raise
    switch_tab(target)
    _pi_goto_url(url)
    return target

def new_tab(url):
    checked = _pi_check_url(url)
    live = _pi_live_tabs()
    for target in _pi_tabs:
        if live[target].get("url") == checked:
            switch_tab(target)
            return target
        if live[target].get("url") == "about:blank":
            switch_tab(target)
            _pi_goto_url(checked)
            return target
    return _pi_create_tab(checked, "reference")

def open_tab(url, role="reference"):
    """Reuse a task-owned role (search/reference), creating only when absent."""
    if not isinstance(role, str) or not role or len(role) > 32:
        raise ValueError("Tab role must be 1..32 characters")
    checked = _pi_check_url(url)
    live = _pi_live_tabs()
    for target, owned_role in _pi_tabs.items():
        if owned_role != role:
            continue
        current_url = live[target].get("url", "")
        switch_tab(target)
        # Preserve the search results/input for follow-up queries on this site.
        same_search_site = role == "search" and _pi_urlparse.urlsplit(current_url).netloc == _pi_urlparse.urlsplit(checked).netloc
        if current_url != checked and not same_search_site:
            _pi_goto_url(checked)
        return target
    return _pi_create_tab(checked, role)

def search_page(query, selector):
    """Use the observed search input in the existing task search tab."""
    _pi_live_tabs()
    target = next((target for target, role in _pi_tabs.items() if role == "search"), None)
    if target is None:
        raise RuntimeError("[BROWSER_SEARCH_TAB] Open a search homepage with open_tab(url, role='search'), inspect its input, then call search_page(query, selector)")
    switch_tab(target)
    fill_input(selector, query, clear_first=True)
    press_key("Enter")
    return target

def owned_tabs():
    live = _pi_live_tabs()
    return [{**live[target], "role": role} for target, role in _pi_tabs.items()]

def close_tab(target):
    target = _pi_helpers._target_id(target)
    if target not in _pi_tabs:
        raise RuntimeError("[BROWSER_TAB_NOT_OWNED] Refusing to close a tab not created by this task")
    live = _pi_live_tabs()
    if target in live:
        result = cdp("Target.closeTarget", targetId=target)
        if result.get("success") is not True:
            raise RuntimeError("[BROWSER_TAB_CLOSE] Close was not confirmed; tab ownership retained")
    _pi_tabs.pop(target, None)
    _pi_save_tabs()

def keep_tab(target):
    """Hand an explicitly requested result tab to the user; skip task cleanup."""
    target = _pi_helpers._target_id(target)
    if target not in _pi_tabs:
        raise RuntimeError("[BROWSER_TAB_NOT_OWNED] This task does not own that tab")
    del _pi_tabs[target]
    _pi_save_tabs()

def close_owned_tabs():
    _pi_live_tabs()
    for target in list(_pi_tabs):
        close_tab(target)
`;
}
