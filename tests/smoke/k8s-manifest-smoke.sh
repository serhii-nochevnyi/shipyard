#!/usr/bin/env bash
set -euo pipefail

for file in \
  k8s/configmap.yaml \
  k8s/pvc.yaml \
  k8s/service.yaml \
  k8s/statefulset.yaml \
  k8s/secret.example.yaml
do
  [[ -f "$file" ]] || { echo "missing $file"; exit 1; }
done

kubectl create --dry-run=client -f k8s/configmap.yaml >/dev/null
kubectl create --dry-run=client -f k8s/pvc.yaml >/dev/null
kubectl create --dry-run=client -f k8s/service.yaml >/dev/null
kubectl create --dry-run=client -f k8s/statefulset.yaml >/dev/null
kubectl create --dry-run=client -f k8s/secret.example.yaml >/dev/null

echo "k8s manifest smoke passed"
