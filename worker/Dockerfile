# Dayson planning worker — nightly jobs by default; run `serve` for on-demand jobs.
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1 TZ=UTC \
    NUMBA_CACHE_DIR=/tmp/numba

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY dayson_worker ./dayson_worker
COPY mechanics ./mechanics
RUN uv sync --frozen --no-dev

# DATABASE_URL must be provided at run time (host vault); never baked into the image.
ENTRYPOINT ["uv", "run", "--no-sync", "dayson-worker"]
CMD ["nightly"]
