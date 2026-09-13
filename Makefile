.PHONY: dev dev-all dev-desktop down logs ps build build-containers migrate shell-backend shell-db test lint package-nc-app

COMPOSE = docker compose -f compose/docker-compose.yml --env-file compose/.env

build-containers: ## Build session container images (kasm-base + all apps)
	$(MAKE) -C containers all

dev: ## Start dev stack (compose services only; does NOT rebuild session images)
	$(COMPOSE) up --build

dev-all: build-containers ## Rebuild ALL session images, then start the dev stack
	$(COMPOSE) up --build

dev-desktop: ## Start full dev stack + webtop desktop for session testing
	$(COMPOSE) --profile testing up --build --remove-orphans

down: ## Stop all services (including webtop if running)
	$(COMPOSE) --profile testing down

reset: ## Stop and wipe all volumes (fresh DB)
	$(COMPOSE) --profile testing down -v

logs: ## Follow logs (all services)
	$(COMPOSE) logs -f

ps: ## Show running services
	$(COMPOSE) ps

build: ## Build images without starting
	$(COMPOSE) build

migrate: ## Run Alembic migrations inside backend container
	$(COMPOSE) exec backend alembic upgrade head

migration: ## Create new migration (usage: make migration MSG="add users table")
	$(COMPOSE) exec backend alembic revision --autogenerate -m "$(MSG)"

shell-backend: ## Shell into backend container
	$(COMPOSE) exec backend bash

shell-db: ## psql into postgres
	$(COMPOSE) exec postgres psql -U lwp -d lwp

test-backend: ## Run backend tests
	$(COMPOSE) exec backend pytest -v

test-frontend: ## Run frontend tests
	$(COMPOSE) exec frontend npm run test

lint-backend: ## Ruff + mypy
	$(COMPOSE) exec backend ruff check app/ && mypy app/

lint-frontend: ## tsc + eslint
	$(COMPOSE) exec frontend npm run lint

webtop: ## Add webtop desktop to a running dev stack (run in separate terminal after make dev)
	$(COMPOSE) --profile testing up webtop

package-nc-app: ## Build the Files action bundle + repackage nextdesk-nextcloud-app.zip
	cd nextcloud-app/nextdesk && npm install && npm run build
	rm -f nextdesk-nextcloud-app.zip
	cd nextcloud-app && zip -r ../nextdesk-nextcloud-app.zip nextdesk \
		-x 'nextdesk/node_modules/*' -x 'nextdesk/src/*' -x 'nextdesk/package*.json' \
		-x 'nextdesk/vite.config.js' -x 'nextdesk/tsconfig.json' -x 'nextdesk/js/*.map'

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'
