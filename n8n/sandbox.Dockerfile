# Code-execution sandbox for agent-platform.
#
# numpy and pandas ship musl wheels, so the alpine base stays small and the
# install is a plain pip run — no compiler, no build toolchain in the image.
# Pin the minor version: a surprise 3.15 on `python:3-alpine` would change
# what user code sees.
FROM python:3.14-alpine

RUN pip install --no-cache-dir --root-user-action=ignore numpy pandas

# Keep the one-shot runner in the image for the Kubernetes Job pilot. Compose
# still bind-mounts sandbox_server.py at /sandbox.py, so its current path is
# unchanged.
COPY sandbox_server.py /sandbox_server.py
COPY sandbox_job.py /sandbox_job.py

# The service itself is bind-mounted (n8n/sandbox_server.py) so edits need
# only a restart, not a rebuild.
EXPOSE 8000
CMD ["python", "-u", "/sandbox.py"]
