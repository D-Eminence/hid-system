mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/synthetic-test" }
  }
  mock_resource "aws_cloudformation_stack" {
    defaults = { outputs = {
      BotId    = "ABCDEFGH01"
      AliasId  = "ABCDEFGHIJ"
      AliasArn = "arn:aws:lex:eu-west-1:123456789012:bot-alias/ABCDEFGH01/ABCDEFGHIJ"
    } }
  }
}
variables {
  name_prefix     = "synthetic-test"
  partner_apn_id  = "synthetic-test"
  support_contact = "mailto:first@example.invalid"
  faqs            = { AccessHelp = { utterances = ["Help me sign in"], answer = "Use your account sign-in page." } }
}
run "initial" {
  command = apply
  assert {
    condition = alltrue([for resource in values(jsondecode(aws_cloudformation_stack.support.template_body).Resources) :
      resource.DeletionPolicy == "Retain" && resource.UpdateReplacePolicy == "Retain"
      if resource.Type == "AWS::Lex::BotVersion"
    ])
    error_message = "Published versions must be retained for rollback."
  }
  assert {
    condition = length([for intent in jsondecode(aws_cloudformation_stack.support.template_body).Resources.Bot.Properties.BotLocales[0].Intents : intent
      if intent.Name == "FallbackIntent" && try(intent.ParentIntentSignature, "") == "AMAZON.FallbackIntent"
    ]) == 1
    error_message = "Lex imports require exactly one canonical fallback intent."
  }
}
run "unchanged" {
  command = plan
  assert {
    condition     = contains(keys(jsondecode(aws_cloudformation_stack.support.template_body).Resources), "Version${substr(sha256(jsonencode({ faqs = var.faqs, support_contact = var.support_contact, locale_id = var.locale_id, fallback_answer = local.fallback_answer })), 0, 20)}")
    error_message = "An unchanged configuration must retain its content revision."
  }
}
run "contact_changed" {
  command = plan
  variables { support_contact = "mailto:changed@example.invalid" }
  assert {
    condition     = !contains(keys(jsondecode(aws_cloudformation_stack.support.template_body).Resources), "Version${substr(sha256(jsonencode({ faqs = var.faqs, support_contact = "mailto:first@example.invalid", locale_id = var.locale_id, fallback_answer = replace(local.fallback_answer, var.support_contact, "mailto:first@example.invalid") })), 0, 20)}")
    error_message = "A changed fallback contact must replace the immutable bot version."
  }
}
run "answer_changed" {
  command = plan
  variables { faqs = { AccessHelp = { utterances = ["Help me sign in"], answer = "Use the updated sign-in page." } } }
  assert {
    condition     = !contains(keys(jsondecode(aws_cloudformation_stack.support.template_body).Resources), "Version${substr(sha256(jsonencode({ faqs = { AccessHelp = { utterances = ["Help me sign in"], answer = "Use your account sign-in page." } }, support_contact = var.support_contact, locale_id = var.locale_id, fallback_answer = local.fallback_answer })), 0, 20)}")
    error_message = "Changed FAQ content must replace the immutable bot version."
  }
}
