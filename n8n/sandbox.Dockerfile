# Code-execution sandbox for agent-platform.
#
# numpy and pandas ship musl wheels, so the alpine base stays small and the
# install is a plain pip run — no compiler, no build toolchain in the image.
# Pin the minor version: a surprise 3.15 on `python:3-alpine` would change
# what user code sees.
FROM python:3.14-alpine

RUN pip install --no-cache-dir --root-user-action=ignore numpy pandas

# The service itself is bind-mounted (n8n/sandbox_server.py) so edits need
# only a restart, not a rebuild.
EXPOSE 8000
CMD ["python", "-u", "/sandbox.py"]
