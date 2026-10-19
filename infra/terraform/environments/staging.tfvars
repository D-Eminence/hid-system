# RETIRED: resources are now owned by production; on-demand staging must be isolated.
aws_region                  = "eu-west-1"
expected_account_id         = "659225405023"
environment                 = "staging"
staging_mode                = "economy"
staging_worker_min_capacity = 1
staging_prelaunch_sizing    = true

staging_novu_api_url          = "https://api.novu.co"
notification_delivery_profile = "email-brevo"

google_oidc_client_ids = ["690536667193-l90c5cqm86g5pt5o93dpvplms2h507l6.apps.googleusercontent.com"]

qoreid_enabled                     = true
qoreid_secret_arn                  = "arn:aws:secretsmanager:eu-west-1:659225405023:secret:/hid/staging/qoreid-lt0E2p"
qoreid_nin_only_enrollment_enabled = false

availability_zones       = ["eu-west-1a", "eu-west-1b"]
public_subnet_cidrs      = ["10.30.0.0/24", "10.30.1.0/24"]
application_subnet_cidrs = ["10.30.10.0/24", "10.30.11.0/24"]
database_subnet_cidrs    = ["10.30.20.0/24", "10.30.21.0/24"]

enable_database        = true
enable_runtime         = true
enable_ingress         = true
enable_backup_plan     = false
enable_ai              = true
ai_allow_eu_processing = true
enable_support_bot     = true
use_existing_secrets   = true

enable_migration_task        = true
migration_image_uri          = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ehr-api@sha256:bbcb90070fe896a4630e81a5f067ce5dc70ed100175499c5a1b943eeff4cae9b"
migration_source_bucket_arn  = "arn:aws:s3:::hid-migration-source-1da62383fb59593cb2679f3ce9"
migration_source_kms_key_arn = "arn:aws:kms:eu-west-1:659225405023:key/ba3f0f61-2ff6-4782-9624-9338c7230bf6"
rds_ca_bundle_base64         = "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUQvekNDQXVlZ0F3SUJBZ0lSQU1nbnlpa1d6NDZ4WTZ5UmdpWXdaM3N3RFFZSktvWklodmNOQVFFTEJRQXcKZ1pjeEN6QUpCZ05WQkFZVEFsVlRNU0l3SUFZRFZRUUtEQmxCYldGNmIyNGdWMlZpSUZObGNuWnBZMlZ6TENCSgpibU11TVJNd0VRWURWUVFMREFwQmJXRjZiMjRnVWtSVE1Rc3dDUVlEVlFRSURBSlhRVEV3TUM0R0ExVUVBd3duClFXMWhlbTl1SUZKRVV5QmxkUzEzWlhOMExURWdVbTl2ZENCRFFTQlNVMEV5TURRNElFY3hNUkF3RGdZRFZRUUgKREFkVFpXRjBkR3hsTUNBWERUSXhNRFV5TURFMk5Ea3hNbG9ZRHpJd05qRXdOVEl3TVRjME9URXlXakNCbHpFTApNQWtHQTFVRUJoTUNWVk14SWpBZ0JnTlZCQW9NR1VGdFlYcHZiaUJYWldJZ1UyVnlkbWxqWlhNc0lFbHVZeTR4CkV6QVJCZ05WQkFzTUNrRnRZWHB2YmlCU1JGTXhDekFKQmdOVkJBZ01BbGRCTVRBd0xnWURWUVFERENkQmJXRjYKYjI0Z1VrUlRJR1YxTFhkbGMzUXRNU0JTYjI5MElFTkJJRkpUUVRJd05EZ2dSekV4RURBT0JnTlZCQWNNQjFObApZWFIwYkdVd2dnRWlNQTBHQ1NxR1NJYjNEUUVCQVFVQUE0SUJEd0F3Z2dFS0FvSUJBUUNpOEpZT2M5Y1lTZ1pICmdZUHhMazZYY2M3SHF6YW12c25qWVU5OERjYjk4eTZpRHFTNDZSYTJOZTAyTUlUdFU1TURMK3FqeGI4V0dEWlYKUlVBOVpTNjl0a1RPM2dsZFc4UWRpU2gzSjZoVk5KUVc4MUYwTTdaV2dWMGdCM243NldDbWZUNElXb3MwQVhITQo1djdNL000dHFWbUNQVmlRblpiMmtkVmxNMy9YYzlHSW5mU01DZ05md0hQVFhsK1BYWCt4Q2ROQmVQYVAvQTVDCjVTMG9LM0hpWGFLR1FBeTNLN1ZuYVFhWWRpdjMyWFVhdGxNNEsyV1M0QU1LdCsyY3czaFRDamxtcUtSSHZZRlEKdmVXQ1hBdWMrVTVQUURKOVN1eEIxYnVGSlpoVDRWUDNKYWdPdVpiaDVOV3BJYk9UeGxBSk9iNXBHRUR1SlRLaQoxZ1FRUVZFRkFnTUJBQUdqUWpCQU1BOEdBMVVkRXdFQi93UUZNQU1CQWY4d0hRWURWUjBPQkJZRUZOWG0rTjg3Ck9GeEs5QWYvYmpTeERDaXVsR1V6TUE0R0ExVWREd0VCL3dRRUF3SUJoakFOQmdrcWhraUc5dzBCQVFzRkFBT0MKQVFFQWtxSWJrZ1o0NXNwdnJnUlE2bjlWS3pETHZOZytXY2lMdG1WcnF5b2h3d0piajRwWXZXd25LUUNrVmM3YwpoVU9TQm1sU0JhNVJFQVBiSDVvOGJkdDAwRlBSckQ2QmRYTFhoYUVDS2dqc0hlMVdXMDhuc2VxdVJLRDh4Vm1jCjhiRVg2c3cvdXRCZUJWM21CKzNadjdlallBYkRGTTR2blJzV3RPK1hxZ1JlT2dybCtjd2RBNlNOUVQ5b1czZTUKclNRK1ZhWGdKdGw5TmhraUl5c3E5QmVZaWd4cVMvQTEzcEhRcDBDT013UzhueitrQlBIaEpUc2FqSENEYzhGNApIZkxpNmNnczlHMGdhUmhUOEZDSDY2T2RHU3FuMTk2c0U3WTNiUEZGRnMvM1Urdnh2bVFnb1pDNmplZ1FYQWc1ClByeGQrVk5YdE5JL2F6aXRUeXNRUHVtSDdBPT0KLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQotLS0tLUJFR0lOIENFUlRJRklDQVRFLS0tLS0KTUlJRi96Q0NBK2VnQXdJQkFnSVJBS3dZanUxUVd4VVpwbjZEMWdPdHdnUXdEUVlKS29aSWh2Y05BUUVNQlFBdwpnWmN4Q3pBSkJnTlZCQVlUQWxWVE1TSXdJQVlEVlFRS0RCbEJiV0Y2YjI0Z1YyVmlJRk5sY25acFkyVnpMQ0JKCmJtTXVNUk13RVFZRFZRUUxEQXBCYldGNmIyNGdVa1JUTVFzd0NRWURWUVFJREFKWFFURXdNQzRHQTFVRUF3d24KUVcxaGVtOXVJRkpFVXlCbGRTMTNaWE4wTFRFZ1VtOXZkQ0JEUVNCU1UwRTBNRGsySUVjeE1SQXdEZ1lEVlFRSApEQWRUWldGMGRHeGxNQ0FYRFRJeE1EVXlNREUyTlRNMU5Gb1lEekl4TWpFd05USXdNVGMxTXpVMFdqQ0JsekVMCk1Ba0dBMVVFQmhNQ1ZWTXhJakFnQmdOVkJBb01HVUZ0WVhwdmJpQlhaV0lnVTJWeWRtbGpaWE1zSUVsdVl5NHgKRXpBUkJnTlZCQXNNQ2tGdFlYcHZiaUJTUkZNeEN6QUpCZ05WQkFnTUFsZEJNVEF3TGdZRFZRUUREQ2RCYldGNgpiMjRnVWtSVElHVjFMWGRsYzNRdE1TQlNiMjkwSUVOQklGSlRRVFF3T1RZZ1J6RXhFREFPQmdOVkJBY01CMU5sCllYUjBiR1V3Z2dJaU1BMEdDU3FHU0liM0RRRUJBUVVBQTRJQ0R3QXdnZ0lLQW9JQ0FRQ0tkQlAxVTRscVdXa2MKQ2IyNS9CS1JUc3ZOVm5JU2lLb2N2YThHQXpKeUtmY0dSYTg1Z21ndTQxVStIejYrMzlLK1hrUmZNMFlTNEJ2UQpGMVh4V1QwYk55eXB1dndDdm1ZU2hTVGpOMVRZMGx0bmNEZGRhaFRhakUvNE1kU09aYi9jOTh1MHl0MDNjSCtHCmhWd1J5VDUwaDB2L1VFb2w1MFZmd2NWQUVaRWdjUVFZaGYxSUZVRmxJdktwbURPcUx1RmFrT25jN2M5YWtLK2kKaXZTVCtKTzF0Z293Ym5Oa24yaUxsU1NnVVdnYjFnamFPc05meXNhZ3YxUlhkbHlQdzNFeWZ3a0ZpZkFRdkYyUApRMGF5WVpmWVM2NDBjY2N2N2VmTTFNU1Z5RkhSOVByckRzRi96cjJTMnNHUGJlSHI3Ui9Id0xsK1M1Si9sOU45Cnkwcms2SUhBV1Y0ZEVrT3ZncG51SktVUndBNDhpdTFIaGk5ZTRtb05TNmVxb0syS21ZM1ZGcHVpeVdjQTczbkgKR1NteWFIK1l1TXJGN0ZudXU3R0VIWkwvbzYrRjVjTDNtajJTSkpoTDdzejByeWY1Q3M1UjR5TjlCSUVqL2Y0OQp3aDg0cE02bmV4b0kwUTR3aVNGQ3hXaUJwalNtT0s2aDd6NisydXRhQjVwMjBYRFpIaHhBbG1seDR2TXVXdGpoClhja2dSRnhjK1pwVk1VM2NBSFVwVkVvTzQ5ZS8rcUtFcFB6cDhYZzRjVG9LdzIrQWZUazNjbXl5WFFmR3dYTVEKWlVITlozdzlJTE1XaWhHQ00yYUdVc0xjR0RSZW5udk5tbm1pbi9TRU5zT1E4S3UwL2EzdGVFendWOWNtbWRZego1aVlzMVl0Z1B2S0ZvYlk2K1QyUlhYaCtBNWtwcndJREFRQUJvMEl3UURBUEJnTlZIUk1CQWY4RUJUQURBUUgvCk1CMEdBMVVkRGdRV0JCU3lVcnNRVm5LbUE4ejYvMkVjaDByQ3ZxcE5tVEFPQmdOVkhROEJBZjhFQkFNQ0FZWXcKRFFZSktvWklodmNOQVFFTUJRQURnZ0lCQUZsajNJRm1naUZ6NWx2VHpGVFJpemhWb2ZoVEpzR3IxNFlma3VjNwpVclhQdVhPd0pvbWQ0dW90MmQvVkllR0pwZm51Uzg0cUdkbVF5R2V3R1RKOWluYXRIc0daZ0hsOU5ITldSd0taCmxUS1RiQmlxN2FxZ3RVU0ZhMDZ2MjAyd3B6VSsxa2FkeEpKZVByYkFCeGlYVmZPbUlXL2ExYTRoUE5jVDNzeUgKRklFZzErQ0dzcDcxVU5qQnV3ZzNKVEtXbmEwc0xTS2N4TE9TT3ZYMWZ6eEs1ZGp6VnBFc3ZRTUI0UFNBelhjYQp2RU5nZzJFclR3Z1RBKzRzNnJSdGlCRjlwQXVzTjFRVnVCYWhZUDNmdHJZNmYzeWNTNEs2NUducXNjeWZ2S3Q1CllnanRFS08zWmVlWDhOcHViTWJ6QyswWjZ0VktmUEZrLzlUWHVKdHd2VmVxb3cwWU1yTEx5UmlZdks3RXpKOTcKcnJreG9LbkhZUVNaK3JIMnRaNVNFMzkyL3JmazFQSkwwY2RIbmtwRGtVRE8rOGNLc0ZqallLQVFTTkM1MnNLWAo3NEFWaDZ3TXd4WXdWWlpKZjIvMlh4a2pNV1doS05lanNaaFVrVElTU21pTHMrcVBlM0w2N0lNN0d5S205L202ClIzcjh4Nk5HamhUc0tINjRpWUpnN0FlS2VheDRiMmU0aEJiNkdYRmZ0eU9zN3VucEVPSVZrSkpnTTZnaDNtd24KUjd2NGd3RmJMS0FES3Qxdkh1ZXJTWk1pVHVOVEdoU2ZDZURNNTNYSS9talpsMkhldUNLUDFtQ0RMbGFPK2daUgpRL0crRTBzQktnRVg0eFRrQWMza2drdVFHZkV4ZEd0bk4yVTJlaEY4MGxCSEI4KzJ5MkUreFdXWGloL1p5SWNXCndPeCsKLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQotLS0tLUJFR0lOIENFUlRJRklDQVRFLS0tLS0KTUlJQ3JqQ0NBalNnQXdJQkFnSVJBTDlTZHpWUGNwcTdHT3B2ZEdvTTgwSXdDZ1lJS29aSXpqMEVBd013Z1pZeApDekFKQmdOVkJBWVRBbFZUTVNJd0lBWURWUVFLREJsQmJXRjZiMjRnVjJWaUlGTmxjblpwWTJWekxDQkpibU11Ck1STXdFUVlEVlFRTERBcEJiV0Y2YjI0Z1VrUlRNUXN3Q1FZRFZRUUlEQUpYUVRFdk1DMEdBMVVFQXd3bVFXMWgKZW05dUlGSkVVeUJsZFMxM1pYTjBMVEVnVW05dmRDQkRRU0JGUTBNek9EUWdSekV4RURBT0JnTlZCQWNNQjFObApZWFIwYkdVd0lCY05NakV3TlRJd01UWTFPREEzV2hnUE1qRXlNVEExTWpBeE56VTRNRGRhTUlHV01Rc3dDUVlEClZRUUdFd0pWVXpFaU1DQUdBMVVFQ2d3WlFXMWhlbTl1SUZkbFlpQlRaWEoyYVdObGN5d2dTVzVqTGpFVE1CRUcKQTFVRUN3d0tRVzFoZW05dUlGSkVVekVMTUFrR0ExVUVDQXdDVjBFeEx6QXRCZ05WQkFNTUprRnRZWHB2YmlCUwpSRk1nWlhVdGQyVnpkQzB4SUZKdmIzUWdRMEVnUlVORE16ZzBJRWN4TVJBd0RnWURWUVFIREFkVFpXRjBkR3hsCk1IWXdFQVlIS29aSXpqMENBUVlGSzRFRUFDSURZZ0FFSldEZ1hlYnZ3alIrQ2UraHhLT0xibnNmTjVXNWRPbFAKWm44a3dXbkQrU0xrVTgxRWFjL0JESnNYR3JNazZqRkQxdmcxNlBFa29TZXZzdVlXbEM4eFI2Rm1UNkY2cG1laApmc01HT3lKcGZLNGZ5b0VQaEtlUW9UMjNsRkljNU9yam8wSXdRREFQQmdOVkhSTUJBZjhFQlRBREFRSC9NQjBHCkExVWREZ1FXQkJTVk5BTjFDSEF6MGVaNzdxejJhZGVxam0zMVR6QU9CZ05WSFE4QkFmOEVCQU1DQVlZd0NnWUkKS29aSXpqMEVBd01EYUFBd1pRSXhBTWxRZUhiY2pvcjQ5anFtY0o5Z1JMV2RFV3BYRzh0aElmNnpmWVEvT0VBZwpkN0dEaDRmUi9PVWswVmZqc0JVTi9nSXdaQjBiR2RYdkszOHM2QUFFLzlJVDA1MWN6L3dNZTlHSXJYMU1uTDFUCjFGNU9xblhKZGl3ZlpSUlRIc1JRL0wwMAotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg=="

regional_certificate_arn = "arn:aws:acm:eu-west-1:659225405023:certificate/144caddd-5a9f-491f-afa6-a9801372dcd7"
internal_certificate_arn = "arn:aws:acm:eu-west-1:659225405023:certificate/25d0d804-06ec-4afa-a621-b1e710795810"

image_uris = {
  "identity-api"        = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/identity-api@sha256:c67c4b0fe3a524c93eaab17ba0cd12b883a2c5f7ccdb5fc355fe7d1ba990a413"
  "ehr-api"             = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ehr-api@sha256:4ac09d711152f5b5d666294289c9d794437e56062acee1103a3c8f31a3ecb133"
  "lab-api"             = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/lab-api@sha256:dcb89ae94208f520db45cbf11e8f1275ce8f4f9fe95c2bbc5d1790f149dfa749"
  "pharmacy-api"        = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/pharmacy-api@sha256:b3e9f4fd189426f13cd84076540c2ddd0714afe4c158ba0ec6d16ac0537514db"
  "ocr-api"             = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ocr-api@sha256:53725dd93321115c666f4f4d6998d9f2abf6bcefc9ad7b8848de6158437d75a4"
  "ocr-worker"          = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/ocr-worker@sha256:7751f287445daf383e5fd509bef57fc18327bb7f97d5861666676c2a8681ca2b"
  "outreach-api"        = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/outreach-api@sha256:f54580f537c0ce874a5c19e4bbef286f3a10da25a72e098f517cfddf30380849"
  "notification-api"    = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/notification-api@sha256:aaa5871a6e208d53b0372ecefd4dcd10bc26e5918afaa218f09a6382a9387c3f"
  "notification-worker" = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/notification-worker@sha256:5c8283d666446e06f3ac14e534235870af7576d39eace7b3fd056e4faa3513bb"
  "event-dispatcher"    = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/event-dispatcher@sha256:e628b6e12285664da21b016698234838726c4de593f31e1a7bfc6c6fd9b27199"
  "gateway"             = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/gateway@sha256:7a97b7e2ba3292c6fe09986e772408f5c4bd399918e08d36c28244bc0ba4a70b"
  "support-api"         = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/support-api@sha256:2541bdc8a1bb73f0cf6c434f6fd3aad37814f79cd00faa5b1d3f53a566576553"
}

# Existing public HID support contact and the current non-clinical FAQ.
support_contact = "mailto:support@healthidentitydirectory.com"
support_faqs = {
  AboutHealthId = {
    utterances = ["What is Health ID", "What is a Health ID", "Whats Health ID about", "Explain Health ID", "What does Health ID do", "What is Health Identity Directory"]
    answer     = "Health ID (Health Identity Directory) connects a patient's Health ID identity with health records and authorized healthcare workflows. It helps patients and providers find and share records through controlled access. Open: https://www.staging.healthidentitydirectory.com/about"
  }
  CreateHealthId = {
    utterances = ["How do I create my Health ID", "How do I register as a patient", "Get my Health ID", "Create a Health ID account"]
    answer     = "Select Get your Health ID. Follow the NIN verification, contact verification code and account activation steps shown on the enrollment page. If verification or activation cannot be completed, contact support. If you already have an account, sign in or recover it instead of creating another. Open: https://staging.healthidentitydirectory.com/enroll"
  }
  HidCode = {
    utterances = ["What is a HIDCode", "Explain my HIDCode", "What does HID code mean"]
    answer     = "Your HIDCode is your Health ID identifier. Healthcare workflows use it to find the correct patient identity. It is different from your NIN, password and access PIN; knowing a HIDCode does not by itself authorize access to health records. Open: https://staging.healthidentitydirectory.com/profile"
  }
  FindHidCode = {
    utterances = ["Where can I find my HIDCode", "Where is my Health ID number", "Show me where to find my HID code"]
    answer     = "Sign in to the patient portal and open Profile. Your identifier appears as Health ID. This public chatbot cannot look up your code or account details. Open: https://staging.healthidentitydirectory.com/profile"
  }
  MedicalRecords = {
    utterances = ["How do I access my health records", "Where are my medical records", "I cannot find a medical record", "How can I view my records"]
    answer     = "Sign in to the patient portal and open Health records. The portal shows records available to your authorized patient account. Ask the facility that created a record about missing clinical information; this public chatbot cannot retrieve records. Open: https://staging.healthidentitydirectory.com/records"
  }
  ShareRecords = {
    utterances = ["How do I share my records with a doctor or hospital", "Allow my doctor to see my records", "How do I approve a hospital access request"]
    answer     = "Ask the provider to use the Health ID access workflow. In the patient portal, open Access to review and approve or deny requests. For the PIN workflow, share your HIDCode and access PIN only with the provider you intend to authorize. Provider role, facility, purpose and access limits still apply. Never share your login password. Open: https://staging.healthidentitydirectory.com/access"
  }
  PatientAccessPin = {
    utterances = ["How does the access PIN work", "How do I manage my access PIN", "Where is my patient PIN", "What is an access PIN"]
    answer     = "Your access PIN is separate from your login password. Set or replace it in Settings after signing in recently. The current form accepts 4 to 8 digits. An authorized provider can use your HIDCode and PIN to request limited record access; the PIN does not bypass provider permissions. Never enter a PIN in this public chat. Open: https://staging.healthidentitydirectory.com/settings"
  }
  RevokeAccess = {
    utterances = ["How do I revoke someone's access", "Stop a hospital seeing my records", "Withdraw access to my health records"]
    answer     = "Open Access to review requests and access history; deny unwanted pending requests. Settings lets you revoke or replace your access PIN, preventing further use of that PIN. This is different from withdrawing an already issued access grant. The current patient page has no grant-withdrawal button; contact Health ID support for help with an existing grant. Open: https://staging.healthidentitydirectory.com/access"
  }
  ForgotPin = {
    utterances = ["What happens if I forget my PIN", "I forgot my access PIN", "Reset my patient access PIN"]
    answer     = "Sign in, open Settings and set a replacement access PIN. You must have signed in recently. If you cannot sign in, use account recovery first. Support will not ask you to reveal your password or PIN in this public chatbot. Open: https://staging.healthidentitydirectory.com/settings"
  }
  DifferentHospitals = {
    utterances = ["Can I use Health ID at different hospitals", "Can I use the same HID at another hospital", "Does my Health ID work at multiple hospitals"]
    answer     = "Health ID is designed around one patient identity that participating facilities can reference. Another facility must use an authorized Health ID workflow and obtain the required access. Participation and record availability can vary; ask the facility whether it supports Health ID. Open: https://www.staging.healthidentitydirectory.com/contact"
  }
  InformationProtection = {
    utterances = ["How does Health ID protect my health information", "Is my health information protected", "How is access to my records controlled"]
    answer     = "Health ID uses authenticated accounts, provider permissions, facility scope, access checks and audit records to control sensitive workflows. Private records are not available through this public FAQ chat. Do not send NINs, passwords, PINs or medical records here. See the privacy and security information for details. Open: https://www.staging.healthidentitydirectory.com/resources/privacy"
  }
  EmergencyAccess = {
    utterances = ["What happens in an emergency", "How does emergency access work", "What is emergency break glass access"]
    answer     = "Health ID has a separate, governed emergency-access workflow for authorized healthcare staff. It requires a recorded reason and audit trail and is different from routine PIN or consent access. The chatbot cannot activate emergency access or guarantee that every facility offers it. In an urgent medical situation, seek appropriate medical care. Open: https://www.staging.healthidentitydirectory.com/contact"
  }
  AccessWithoutPin = {
    utterances = ["Can a hospital access my records without my PIN", "Can a doctor read records without a patient PIN", "Is the PIN the only way to authorize access"]
    answer     = "A PIN is one access route, not the only one. Approved access requests can authorize a provider without a PIN; a separately governed emergency workflow may also apply. Knowing your HIDCode alone is not permission. Access remains subject to provider permissions and the applicable authorization rules. Open: https://staging.healthidentitydirectory.com/access"
  }
  MigrateRecords = {
    utterances = ["How do I migrate my existing health records", "Import my paper medical records", "How do I move old records into Health ID"]
    answer     = "Ask your care facility or an authorized Health ID Migrate user to use the document upload and review workflow. Extracted information requires human review and the correct patient match before any supported clinical publication. Uploading a document does not automatically make it a final clinical record. Open: https://migrate.staging.healthidentitydirectory.com"
  }
  HidMigrate = {
    utterances = ["What is Health ID Migrate", "What is HID Migrate", "Where do I upload migration documents", "Explain Health ID Migrate"]
    answer     = "Health ID Migrate is the document digitization and migration workspace. Authorized users upload existing records, review extracted information and confirm the patient before supported publication. It does not replace clinical review or automatically make extracted text an official record. Open: https://migrate.staging.healthidentitydirectory.com"
  }
  ProviderRegistration = {
    utterances = ["How do healthcare providers register", "How do hospitals join Health ID", "Register a laboratory or pharmacy"]
    answer     = "Use Setup Your Facility on the public site and choose the relevant product. Submit the required CAC registration and administrator details. Verification, profile completion and Health ID review are separate steps; submitting the form does not activate a facility or create a signed-in administrator session. Open: https://www.staging.healthidentitydirectory.com/provider/apply"
  }
  HospitalHealthId = {
    utterances = ["Can a hospital create its own Health ID", "Can a facility issue its own patient HID code", "Do hospitals create separate patient identities"]
    answer     = "A hospital can apply for a Health ID facility workspace. Patient Health IDs belong to the shared patient identity system; a facility must use the approved enrollment or identity workflow instead of creating a competing patient identity. Existing patients should keep their current Health ID. Open: https://www.staging.healthidentitydirectory.com/provider/apply"
  }
  NinCacVerification = {
    utterances = ["What is NIN/CAC verification", "Why do I need NIN verification", "What does CAC verification check"]
    answer     = "NIN verification checks patient identity information against the identity-verification provider. CAC verification checks an organization's registration information. A successful provider lookup does not by itself approve a facility or prove that an applicant is authorized to represent it; account and organization review rules still apply. Submit identifiers only in the official forms, not this chat. Open: https://www.staging.healthidentitydirectory.com/provider/apply"
  }
  ProviderRecordScope = {
    utterances = ["What records can providers access", "Can a provider see all my medical records", "Which health records can my doctor view"]
    answer     = "Providers can access only records permitted by their role, facility, purpose and the applicable patient authorization. A Health ID identifier or staff account does not grant unrestricted access. What is available also depends on the records and workflow involved. Open: https://staging.healthidentitydirectory.com/access"
  }
  ContactSupport = {
    utterances = ["How do I contact Health ID support", "Contact Health ID support", "How can I get help from support"]
    answer     = "Email Health ID support at support@healthidentitydirectory.com. Explain the issue without including passwords, PINs, verification codes, NINs or medical records in public chat. The chatbot cannot sign in for you or change your account. Open: mailto:support@healthidentitydirectory.com"
  }
  Pricing = {
    utterances = ["Is Health ID free", "How much does Health ID cost", "What are the Health ID fees"]
    answer     = "For current Health ID pricing and any patient or provider charges, contact Health ID support. This chatbot does not have an approved fee schedule and cannot promise that every service is free. Open: mailto:support@healthidentitydirectory.com"
  }
  SupportedFacilities = {
    utterances = ["Which healthcare facilities support Health ID", "Which hospitals use Health ID", "Find a participating Health ID facility"]
    answer     = "Ask your healthcare facility whether it currently supports Health ID, or contact Health ID support for participation information. This chatbot does not have a verified public directory and cannot confirm an individual facility's participation. Open: mailto:support@healthidentitydirectory.com"
  }
  NigeriaAvailability = {
    utterances = ["Is Health ID available across Nigeria", "Is Health ID in every Nigerian state", "Where is Health ID available in Nigeria"]
    answer     = "Contact Health ID support to confirm availability at your location and healthcare facility. This chatbot does not have an approved rollout list and cannot promise coverage in every state or facility. Open: mailto:support@healthidentitydirectory.com"
  }
  IncorrectInformation = {
    utterances = ["What happens if my information is incorrect", "My Health ID details are wrong", "Correct an error in my health record"]
    answer     = "Review your Profile to identify the incorrect detail. Contact Health ID support about identity or account information; contact the facility that created a clinical record about a clinical correction. Corrections must follow the appropriate review process. Do not create a second account to work around an error. Open: https://staging.healthidentitydirectory.com/profile"
  }
  UpdateInformation = {
    utterances = ["How do I update my information", "Change my profile information", "Update my Health ID details"]
    answer     = "Open Profile to review your current details. The current patient profile displays identity information rather than offering unrestricted editing. Contact Health ID support for identity or contact corrections; the care facility handles clinical-record corrections. Settings is for available account controls such as the access PIN. Open: https://staging.healthidentitydirectory.com/profile"
  }
  SigningIn = {
    utterances = ["How do I sign in", "Where is the patient login", "Log in to my Health ID account"]
    answer     = "Open the patient sign-in page and use your registered email or Health ID and password, or the available Google sign-in option. Provider and admin workspaces use their own access scopes. If patient sign-in fails, use the recovery option. Open: https://staging.healthidentitydirectory.com/sign-in"
  }
  PasswordRecovery = {
    utterances = ["I forgot my password", "How do I recover my account", "Reset my Health ID password"]
    answer     = "Use Forgot password on the patient sign-in page. Follow the recovery form and verification steps using your own registered details. Do not share verification codes, passwords or access PINs in chat. Open: https://staging.healthidentitydirectory.com/recover"
  }
  MedicalAdviceBoundary = {
    utterances = ["I have chest pain what medicine should I take", "What medicine should I take", "Can you diagnose my symptoms", "What treatment do I need", "I have a fever what should I take", "Which drug should I use", "I need medical advice", "Tell me a dose for my medicine", "I have chest pain", "I cannot breathe"]
    answer     = "This chatbot helps with using Health ID; it cannot diagnose symptoms, prescribe medicines or recommend treatment. Please contact a qualified healthcare professional. If you think this may be an emergency, seek urgent medical care. Do not rely on this chatbot for medical decisions."
  }
}

# Keep unchanged token agents independent of the Identity API rollout.
workload_token_agent_image_uri = "659225405023.dkr.ecr.eu-west-1.amazonaws.com/staging/hid/identity-api@sha256:40b4cbf899afd28c110ee12be05e15eb28ee991319653e5fc3abb242a2e9b9d2"

anthropic_secret_arn = "arn:aws:secretsmanager:eu-west-1:659225405023:secret:/hid/staging/anthropic-oZj8Az"

anthropic_secret_json_key = "apiKey"

anthropic_model_id = "claude-sonnet-4-6"

ai_generation_provider = "anthropic"

ai_allow_anthropic_us_processing = true

configuration_retired = true
