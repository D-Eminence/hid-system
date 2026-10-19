output "bot_id" {
  value = aws_cloudformation_stack.support.outputs["BotId"]
}

output "alias_id" {
  value = aws_cloudformation_stack.support.outputs["AliasId"]
}

output "alias_arn" {
  value = aws_cloudformation_stack.support.outputs["AliasArn"]
}
