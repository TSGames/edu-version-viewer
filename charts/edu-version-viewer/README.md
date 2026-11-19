# edu-version-viewer Helm Chart

Deploys [edu-version-viewer](https://github.com/tsgames/edu-version-viewer) –
a dependency-free viewer that polls edu-sharing `_about` endpoints and shows
version, last sync, services/modules, features and plugins – to Kubernetes.

The chart is published as an OCI artifact to the GitHub Container Registry:

```
oci://ghcr.io/tsgames/charts/edu-version-viewer
```

## Minimal valid install

The app is behind HTTP Basic auth, so the only value you must provide is an
admin password (an empty password disables the account). Everything else has a
working default.

```sh
helm install evv oci://ghcr.io/tsgames/charts/edu-version-viewer \
  --version 1.0.0 \
  --set auth.adminPassword=please-change-me
```

Then reach the UI via port-forward:

```sh
kubectl port-forward svc/evv-edu-version-viewer 8080:3000
# open http://localhost:8080/  (login: admin / please-change-me)
```

Minimal `values.yaml` equivalent:

```yaml
auth:
  adminPassword: please-change-me
```

> For production, prefer an existing Secret over an inline password:
> `--set auth.existingSecret=my-creds` (keys `ADMIN_PASSWORD` / `VIEWER_PASSWORD`,
> configurable via `auth.adminPasswordKey` / `auth.viewerPasswordKey`).

## Versioning

Chart `version` and `appVersion` are kept in lockstep and set by CI from the git
tag: pushing `vX.Y.Z` publishes chart `X.Y.Z` pinned to image `:X.Y.Z`. Pushes to
`main` publish a dev prerelease (`0.0.0-dev.<sha>`) pinned to the matching
`sha-<sha>` image. Because `image.tag` defaults to `.Chart.AppVersion`, you
normally do not set it.

## Key configuration

| Key | Default | Description |
| --- | --- | --- |
| `image.repository` | `ghcr.io/tsgames/edu-version-viewer` | Container image |
| `image.tag` | `""` → `appVersion` | Image tag override |
| `auth.adminPassword` | `""` | Admin (read+write) password |
| `auth.viewerPassword` | `""` | Read-only password (empty = disabled) |
| `auth.existingSecret` | `""` | Use a pre-created Secret instead |
| `auth.sessionSecret` | `""` | Signs the session cookie; empty = random per pod (logins drop on restart) |
| `config.sessionTtlSeconds` | `3600` | Session lifetime (1 h) |
| `config.allowedSourceRanges` | `[]` | Source-IP allowlist enforced by the app (all but `/api/public/*`, `/api/health`); empty = off |
| `config.trustProxyHops` | `1` | Trusted reverse proxies for the client IP (`X-Forwarded-For`); 1 = ingress controller |
| `ipRanges` | `134.76: GWDG` | IP range → tag mappings (auto network tags); empty = off |
| `config.cronSchedule` | `0 */2 * * *` | Poll schedule (every 2 h) |
| `config.requestTimeoutMs` | `10000` | Per-endpoint fetch timeout |
| `config.failThreshold` | `2` | Consecutive failures before `error` |
| `persistence.enabled` | `true` | PVC for `/data` (config + fetches) |
| `persistence.size` | `1Gi` | PVC size |
| `persistence.retain` | `true` | Keep the PVC (and data) on `helm uninstall` |
| `service.type` / `service.port` | `ClusterIP` / `3000` | Service |
| `ingress.enabled` | `false` | Ingress |
| `resources.limits` | `100m` / `128Mi` | CPU / memory limits |
| `resources.requests` | `50m` / `64Mi` | CPU / memory requests |
| `networkPolicy.enabled` | `true` | Restrict pod networking (see below) |
| `networkPolicy.ingress.controller.namespace` | `traefik` | Only this ingress controller may reach the pod (k3s: `kube-system`) |
| `serviceAccount.create` | `true` | Dedicated SA, token automount off |
| `autoscaling.enabled` | `false` | HPA (needs RWX storage for >1 replica) |

See [`values.yaml`](./values.yaml) for the full list.

## NetworkPolicy

With `networkPolicy.enabled=true` (default) the pod is restricted so it can reach
the **public internet** – which it needs to poll the external edu-sharing
endpoints – but **not** cluster-internal services:

- **Egress DNS**: allowed to port 53 (UDP/TCP) as a dedicated rule.
- **Egress internet**: allowed to `0.0.0.0/0` on ports 443/80, with private
  ranges (`10/8`, `172.16/12`, `192.168/16`), link-local/metadata
  (`169.254/16`) and CGNAT (`100.64/10`) excluded.
- **Ingress**: only the ingress controller may reach the app port – by default
  Traefik pods (`app.kubernetes.io/name: traefik`) in namespace `traefik`
  (`networkPolicy.ingress.controller`; on k3s set the namespace to
  `kube-system`). Extra peers go to `networkPolicy.ingress.from`;
  `fromAnywhere=true` allows every source. This keeps clients from bypassing the
  ingress with a forged `X-Forwarded-For`. Kubelet probes come from the node and
  are not affected by NetworkPolicies on common CNIs (Calico, Cilium).

## Source-IP allowlist

`config.allowedSourceRanges` restricts the whole app – UI, login and all
`/api/*` routes – to the listed IPv4 ranges. Only `/api/public/*` (public
instance list) and `/api/health` stay open. Others get `403`. The check runs in
the app, so it works with any ingress controller:

```yaml
config:
  allowedSourceRanges: [134.76.0.0/16, 10.0.0.0/8]
  trustProxyHops: "1"   # Traefik -> pod
```

The client IP is the address the outermost trusted proxy saw
(`config.trustProxyHops`, see `values.yaml`). Traefik must see the real client
IP itself, e.g. via `externalTrafficPolicy: Local` on its Service or proxy
protocol from the load balancer.

> Enforcement requires a NetworkPolicy-capable CNI (e.g. Calico or Cilium).
> `kindnet` (kind's default) accepts the object but does not enforce it.

## Notes

- Runs as non-root (uid/gid 1000) with a read-only root filesystem; only the
  mounted `/data` volume is writable.
- The PVC uses `ReadWriteOnce` and the Deployment uses the `Recreate` strategy,
  so a single replica owns the volume. For autoscaling use a `ReadWriteMany`
  storage class.
- The PVC carries `helm.sh/resource-policy: keep` (via `persistence.retain`), so
  it survives `helm uninstall`. Upgrades and pod restarts keep the data too.
  Delete the PVC manually (`kubectl delete pvc <release>-edu-version-viewer`)
  if you really want the data gone. Whether the underlying PV is then reclaimed
  depends on the StorageClass `reclaimPolicy`.
- The ServiceAccount carries no RBAC and has token automounting disabled — the
  app never calls the Kubernetes API.
