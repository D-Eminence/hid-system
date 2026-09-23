output "budget_names" { value = [aws_budgets_budget.cash.name, aws_budgets_budget.gross_actual.name, aws_budgets_budget.gross_forecast.name] }
