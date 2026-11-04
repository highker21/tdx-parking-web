#!/bin/bash
# launchd／systemd 進入點範例：改成你的 node 與專案路徑
exec /usr/local/bin/node "$(dirname "$0")/tw_relay.mjs"
