# In-stack backup image.
#
# Runs inside the compose stack on purpose: the host-side scheduled task fires at
# 03:30, when Docker Desktop is usually not running, and neither schtasks.exe nor
# PowerShell's Set-ScheduledTask can be changed on this machine without admin.
# A container can only run while the stack is up -- which is exactly the
# precondition a backup needs. No host scheduler involved.
FROM postgres:17-alpine

# bash for ${var//search/replace}; curl for the heartbeat; tar/gzip come from busybox.
RUN apk add --no-cache bash curl

COPY backup.sh /usr/local/bin/backup.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/entrypoint.sh

CMD ["/usr/local/bin/entrypoint.sh"]
