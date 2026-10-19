data "aws_iam_policy_document" "lex_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lexv2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lex" {
  name_prefix        = "${var.name_prefix}-support-lex-"
  assume_role_policy = data.aws_iam_policy_document.lex_assume.json
}

locals {
  fallback_answer = "I could not match that to a Health ID FAQ. Contact Health ID support: ${var.support_contact}. This chatbot cannot diagnose or recommend treatment. For symptoms or treatment questions, contact a qualified healthcare professional. If you think this is an emergency, seek urgent medical care."
  faq_revision = sha256(jsonencode({
    faqs            = var.faqs
    support_contact = var.support_contact
    locale_id       = var.locale_id
    fallback_answer = local.fallback_answer
  }))
  version_id = "Version${substr(local.faq_revision, 0, 20)}"
}

# Cloud Control returns BotLocales=null after creating Lex correctly (awscc
# issue #2091). Use the normal CloudFormation stack readback instead. A content-
# bound logical version ID publishes a new immutable version when FAQs change.
resource "aws_cloudformation_stack" "support" {
  name = "${var.name_prefix}-support-faq"
  template_body = jsonencode({
    AWSTemplateFormatVersion = "2010-09-09"
    Resources = merge({
      Bot = {
        Type = "AWS::Lex::Bot"
        Properties = {
          Name                    = "${var.name_prefix}-support-faq"
          RoleArn                 = aws_iam_role.lex.arn
          IdleSessionTTLInSeconds = 300
          DataPrivacy             = { ChildDirected = false }
          AutoBuildBotLocales     = true
          BotTags                 = [{ Key = "aws-apn-id", Value = var.partner_apn_id }]
          TestBotAliasTags        = [{ Key = "aws-apn-id", Value = var.partner_apn_id }]
          BotLocales = [{
            LocaleId               = var.locale_id
            NluConfidenceThreshold = 0.4
            Intents = concat([for name, faq in var.faqs : {
              Name             = name
              SampleUtterances = [for utterance in faq.utterances : { Utterance = utterance }]
              IntentClosingSetting = {
                IsActive        = true
                ClosingResponse = { MessageGroupsList = [{ Message = { PlainTextMessage = { Value = faq.answer } } }] }
              }
              }], [{
              Name                  = "FallbackIntent"
              ParentIntentSignature = "AMAZON.FallbackIntent"
              IntentClosingSetting = {
                IsActive = true
                ClosingResponse = { MessageGroupsList = [{ Message = { PlainTextMessage = {
                  Value = local.fallback_answer
                } } }] }
              }
            }])
          }]
        }
      }
      Alias = {
        Type = "AWS::Lex::BotAlias"
        Properties = {
          BotAliasName           = "live"
          BotId                  = { Ref = "Bot" }
          BotVersion             = { "Fn::GetAtt" = [local.version_id, "BotVersion"] }
          BotAliasTags           = [{ Key = "aws-apn-id", Value = var.partner_apn_id }]
          BotAliasLocaleSettings = [{ LocaleId = var.locale_id, BotAliasLocaleSetting = { Enabled = true } }]
        }
      }
      }, {
      (local.version_id) = {
        Type                = "AWS::Lex::BotVersion"
        DeletionPolicy      = "Retain"
        UpdateReplacePolicy = "Retain"
        Properties = {
          BotId                         = { Ref = "Bot" }
          Description                   = "FAQ revision ${local.faq_revision}"
          BotVersionLocaleSpecification = [{ LocaleId = var.locale_id, BotVersionLocaleDetails = { SourceBotVersion = "DRAFT" } }]
        }
      }
    })
    Outputs = {
      BotId    = { Value = { Ref = "Bot" } }
      AliasId  = { Value = { "Fn::GetAtt" = ["Alias", "BotAliasId"] } }
      AliasArn = { Value = { "Fn::GetAtt" = ["Alias", "Arn"] } }
    }
  })
}
