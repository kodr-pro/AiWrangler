# Render image for docs/demo/demo.tape. The stock vhs image has no Node,
# and the demo runs the published package through npx.
#
#   docker build -t aiwrangler-vhs -f docs/demo/vhs.Dockerfile docs/demo
#   docker run --rm -e TYPESAFE_API_KEY -v "$(git rev-parse --show-toplevel):/work" -w /work aiwrangler-vhs docs/demo/demo.tape
FROM ghcr.io/charmbracelet/vhs
RUN apk add --no-cache nodejs npm jq
