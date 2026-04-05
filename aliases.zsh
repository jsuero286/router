# =========================
# 🧠 LLM Router — Aliases ZSH
# =========================
# Añade este contenido a tu ~/.zshrc:
#   echo "source $(pwd)/aliases/aliases.zsh" >> ~/.zshrc
#   source ~/.zshrc

ROUTER="--openai-api-base http://router.casa.lan/v1 --openai-api-key none --no-show-model-warnings"

# ── Modelos automáticos ──────────────────────────────────────
alias aider-auto="aider $ROUTER --model openai/auto"
alias aider-fast="aider $ROUTER --model openai/fast"
alias aider-reason="aider $ROUTER --model openai/reasoning"

# ── Nodos específicos ────────────────────────────────────────
alias aider-mac="aider $ROUTER --model openai/mac-fast"
alias aider-mac-reason="aider $ROUTER --model openai/mac-reason"
alias aider-mac-coder="aider $ROUTER --model openai/mac-coder"
alias aider-5070="aider $ROUTER --model openai/gpu5070-fast"
alias aider-4070="aider $ROUTER --model openai/gpu4070-coder"
alias aider-4070-reason="aider $ROUTER --model openai/gpu4070-reason"

# ── Cloud ────────────────────────────────────────────────────
alias aider-gemini="aider $ROUTER --model openai/gemini-flash"
alias aider-gemini-pro="aider $ROUTER --model openai/gemini-pro"
alias aider-claude="aider $ROUTER --model openai/claude-sonnet"
alias aider-claude-opus="aider $ROUTER --model openai/claude-opus"

# ── Skills ───────────────────────────────────────────────────
alias aider-angular="aider $ROUTER --model openai/angular-expert-gemini"
alias aider-angular-local="aider $ROUTER --model openai/angular-expert-4070"
alias aider-spring="aider $ROUTER --model openai/spring-expert-gemini"
alias aider-spring-local="aider $ROUTER --model openai/spring-expert-4070"
alias aider-debug="aider $ROUTER --model openai/debug-gemini"
alias aider-debug-local="aider $ROUTER --model openai/debug-4070"
alias aider-refactor="aider $ROUTER --model openai/refactor-gemini"
alias aider-refactor-local="aider $ROUTER --model openai/refactor-4070"
alias aider-web="aider $ROUTER --model openai/web-design-gemini"
alias aider-web-local="aider $ROUTER --model openai/web-design-4070"
