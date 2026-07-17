# cctrace — build & install
#
# `make install` compiles cctrace into a single standalone binary and puts it
# on your PATH. The compiled binary is the recommended install: it doesn't
# need bun at runtime, and it receives argv directly from the OS — so
# `cctrace -- --continue` works. (Running through bun's CLI — bunx, bun run,
# or the bun-link shim — bun itself eats a leading "--".)

PREFIX ?= $(HOME)/.local
BINDIR := $(PREFIX)/bin
BIN    := dist/cctrace

.PHONY: help build test install uninstall link clean publish

help:
	@echo "cctrace targets:"
	@echo "  make build      compile standalone binary -> $(BIN) (bun needed to build, not to run)"
	@echo "  make install    build + install to $(BINDIR)/cctrace  [PREFIX=$(PREFIX)]"
	@echo "  make uninstall  remove $(BINDIR)/cctrace"
	@echo "  make test       run unit tests (bun test)"
	@echo "  make link       dev install via bun link (runs from source; bun eats a leading '--')"
	@echo "  make publish    npm publish using token from .env"
	@echo "  make clean      remove dist/ and .cache/"

build:
	bun build --compile --define CCTRACE_GIT_SHA="\"$$(git rev-parse --short HEAD 2>/dev/null || true)\"" --outfile $(BIN) src/cli.ts
	@echo "built $(BIN)"

test:
	bun test

install: build
	install -d $(BINDIR)
	install -m 0755 $(BIN) $(BINDIR)/cctrace
	@echo "installed $(BINDIR)/cctrace"
	@case ":$$PATH:" in *":$(BINDIR):"*) ;; *) echo "note: $(BINDIR) is not on your PATH" ;; esac

uninstall:
	rm -f $(BINDIR)/cctrace

link:
	bun link

publish:
	@set -a && . ./.env && set +a && \
	npm publish --fetch-timeout=300000 --fetch-retry-maxtimeout=60000

clean:
	rm -rf dist .cache
