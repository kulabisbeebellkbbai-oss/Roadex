# Project human-thread relay authority

Roadex sends binding, question-response, and transcript response records directly
to the Overseer API authority:

`http://127.0.0.1:8766/api/roadex/project-human-thread-relay`

This service-to-service route is intentionally not published through the
protected browser gateway. The direct authority supplies the exact `Host`
value `127.0.0.1:8766`; changing the port or routing through another hostname
is rejected. The relay remains disabled unless
`ROADEX_PROJECT_HUMAN_THREAD_RELAY_ENABLED=true` and reads its shared secret
from the private no-follow file named by
`ROADEX_PROJECT_HUMAN_THREAD_RELAY_SECRET_FILE`.
