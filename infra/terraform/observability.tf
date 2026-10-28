resource "aws_prometheus_workspace" "main" {
  alias = "${var.name_prefix}-metrics"
  tags  = { Name = "${var.name_prefix}-metrics" }
}

data "aws_iam_policy_document" "grafana_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["grafana.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "grafana" {
  name               = "${var.name_prefix}-grafana"
  assume_role_policy = data.aws_iam_policy_document.grafana_assume_role.json
  tags               = { Name = "${var.name_prefix}-grafana" }
}

resource "aws_iam_role_policy_attachment" "grafana_prometheus" {
  role       = aws_iam_role.grafana.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonPrometheusQueryAccess"
}

resource "aws_iam_role_policy_attachment" "grafana_cloudwatch" {
  role       = aws_iam_role.grafana.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchReadOnlyAccess"
}

resource "aws_grafana_workspace" "main" {
  name                     = "${var.name_prefix}-grafana"
  account_access_type      = "CURRENT_ACCOUNT"
  authentication_providers = ["AWS_SSO"]
  permission_type          = "SERVICE_MANAGED"
  role_arn                 = aws_iam_role.grafana.arn
  data_sources             = ["PROMETHEUS", "CLOUDWATCH"]
  description              = "Amrutam production dashboards and alerts."
  tags                     = { Name = "${var.name_prefix}-grafana" }
  depends_on = [
    aws_iam_role_policy_attachment.grafana_prometheus,
    aws_iam_role_policy_attachment.grafana_cloudwatch,
  ]
}
