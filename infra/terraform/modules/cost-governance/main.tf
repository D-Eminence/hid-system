locals {
  cash_notifications = {
    actual_50   = ["ACTUAL", 50], actual_80 = ["ACTUAL", 80], actual_100 = ["ACTUAL", 100]
    forecast_80 = ["FORECASTED", 80], forecast_100 = ["FORECASTED", 100]
  }
  gross_actual_notifications = {
    actual_50 = ["ACTUAL", 50], actual_75 = ["ACTUAL", 75], actual_90 = ["ACTUAL", 90], actual_100 = ["ACTUAL", 100]
  }
  gross_forecast_notifications = {
    forecast_80 = ["FORECASTED", 80], forecast_100 = ["FORECASTED", 100]
  }
  sns_subscribers = var.notification_sns_arn == "" ? [] : [var.notification_sns_arn]
}

resource "aws_budgets_budget" "cash" {
  name         = "hid-monthly-cash-exposure"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_cash_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_types {
    include_credit = true
  }

  dynamic "notification" {
    for_each = local.cash_notifications
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value[1]
      threshold_type             = "PERCENTAGE"
      notification_type          = notification.value[0]
      subscriber_email_addresses = [var.notification_email]
      subscriber_sns_topic_arns  = local.sns_subscribers
    }
  }
}

resource "aws_budgets_budget" "gross_actual" {
  name         = "hid-monthly-gross-consumption"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_gross_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_types {
    include_credit = false
  }

  dynamic "notification" {
    for_each = local.gross_actual_notifications
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value[1]
      threshold_type             = "PERCENTAGE"
      notification_type          = notification.value[0]
      subscriber_email_addresses = [var.notification_email]
      subscriber_sns_topic_arns  = local.sns_subscribers
    }
  }
}

resource "aws_budgets_budget" "gross_forecast" {
  name         = "hid-monthly-gross-consumption-forecast"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_gross_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_types {
    include_credit = false
  }

  dynamic "notification" {
    for_each = local.gross_forecast_notifications
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value[1]
      threshold_type             = "PERCENTAGE"
      notification_type          = notification.value[0]
      subscriber_email_addresses = [var.notification_email]
      subscriber_sns_topic_arns  = local.sns_subscribers
    }
  }
}

resource "aws_ce_anomaly_monitor" "services" {
  name              = "hid-account-service-cost-anomalies"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

resource "aws_ce_anomaly_monitor" "project" {
  name         = "hid-project-tag-cost-anomalies"
  monitor_type = "CUSTOM"
  monitor_specification = jsonencode({
    Tags = {
      Key          = "Project"
      Values       = ["HID"]
      MatchOptions = ["EQUALS", "CASE_SENSITIVE"]
    }
  })
}

resource "aws_ce_anomaly_subscription" "daily" {
  name = "hid-cost-anomaly-notifications"
  monitor_arn_list = [
    aws_ce_anomaly_monitor.services.arn,
    aws_ce_anomaly_monitor.project.arn
  ]
  frequency = "DAILY"

  subscriber {
    type    = "EMAIL"
    address = var.notification_email
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = [tostring(var.anomaly_threshold_usd)]
    }
  }
}
