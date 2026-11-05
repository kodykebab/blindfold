# Source before node/forge: this machine's shell profile defines a recursive `node` function.
unset -f node npm npx 2>/dev/null
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$HOME/.foundry/bin:$PATH"
