{{/*
Expand the name of the chart.
*/}}
{{- define "edu-version-viewer.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "edu-version-viewer.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart name and version as used by the chart label.
*/}}
{{- define "edu-version-viewer.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "edu-version-viewer.labels" -}}
helm.sh/chart: {{ include "edu-version-viewer.chart" . }}
{{ include "edu-version-viewer.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "edu-version-viewer.selectorLabels" -}}
app.kubernetes.io/name: {{ include "edu-version-viewer.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name
*/}}
{{- define "edu-version-viewer.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "edu-version-viewer.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Resolve the image tag, falling back to the chart's appVersion when image.tag is
empty. CI sets appVersion at package time, so the published chart pins the
matching image without mutating values.yaml.
*/}}
{{- define "edu-version-viewer.imageTag" -}}
{{- .Values.image.tag | default .Chart.AppVersion -}}
{{- end }}

{{/*
Name of the Secret holding the credentials (existing or chart-managed).
*/}}
{{- define "edu-version-viewer.secretName" -}}
{{- if .Values.auth.existingSecret }}
{{- .Values.auth.existingSecret }}
{{- else }}
{{- include "edu-version-viewer.fullname" . }}
{{- end }}
{{- end }}
