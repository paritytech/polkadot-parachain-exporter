[![GitLab Status](https://gitlab.parity.io/parity/polkadot-parachain-exporter/badges/master/pipeline.svg)](https://gitlab.parity.io/parity/polkadot-parachain-exporter/pipelines)

# DEPRECATED

Use https://github.com/paritytech/polkadot-introspector instead

# polkadot-parachain-exporter

Prometheus exporter for monitoring parachains on Kusama & Polkadot.

See [.env.example](./.env.example) for configuration options. If you want to run the exporter and Prometheus with
`docker-compose`, make sure to run [render_local_prometheus_rules.sh](scripts/render_local_prometheus_rules.sh) after
creating an `.env` file.
