# Source before node/forge. Clears shell wrappers some profiles define for node/npm/npx, puts Foundry on PATH,
# and switches to Node 22 through nvm when nvm is installed.
unset -f node npm npx 2>/dev/null
export PATH="$HOME/.foundry/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" && nvm use 22 >/dev/null 2>&1
node --version 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])\.' || echo "env.sh: need Node >= 22, have $(node --version 2>/dev/null || echo none)" >&2
command -v forge >/dev/null || echo "env.sh: forge not found; install Foundry (foundryup)" >&2
