variable "name_prefix" {
  type = string
}

variable "partner_apn_id" {
  type = string
}

variable "locale_id" {
  type    = string
  default = "en_GB"
}

variable "faqs" {
  type = map(object({
    utterances = list(string)
    answer     = string
  }))
}

variable "support_contact" {
  type = string
}
