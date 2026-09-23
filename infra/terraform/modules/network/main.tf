locals {
  az_map = { for index, az in var.availability_zones : tostring(index) => az }
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.name_prefix }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name_prefix}-igw" }
}

resource "aws_subnet" "public" {
  for_each = local.az_map

  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.value
  cidr_block              = var.public_subnet_cidrs[tonumber(each.key)]
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name_prefix}-edge-${each.key}" }
}

resource "aws_subnet" "application" {
  for_each = local.az_map

  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.value
  cidr_block              = var.application_subnet_cidrs[tonumber(each.key)]
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name_prefix}-application-${each.key}" }
}

resource "aws_subnet" "database" {
  for_each = local.az_map

  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.value
  cidr_block              = var.database_subnet_cidrs[tonumber(each.key)]
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name_prefix}-database-${each.key}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name_prefix}-edge" }
}

resource "aws_route" "public" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  for_each       = aws_subnet.public
  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  count  = var.nat_gateway_count
  domain = "vpc"
  tags   = { Name = "${var.name_prefix}-nat-${count.index}" }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_nat_gateway" "main" {
  count = var.nat_gateway_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[tostring(count.index)].id
  tags          = { Name = "${var.name_prefix}-nat-${count.index}" }
}

resource "aws_route_table" "application" {
  for_each = local.az_map
  vpc_id   = aws_vpc.main.id
  tags     = { Name = "${var.name_prefix}-application-${each.key}" }
}

resource "aws_route" "application_egress" {
  for_each = var.nat_gateway_count == 0 ? {} : local.az_map

  route_table_id         = aws_route_table.application[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[var.nat_gateway_count == 1 ? 0 : min(tonumber(each.key), var.nat_gateway_count - 1)].id
}

resource "aws_route_table_association" "application" {
  for_each       = aws_subnet.application
  subnet_id      = each.value.id
  route_table_id = aws_route_table.application[each.key].id
}

resource "aws_route_table" "database" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.name_prefix}-database" }
}

resource "aws_route_table_association" "database" {
  for_each       = aws_subnet.database
  subnet_id      = each.value.id
  route_table_id = aws_route_table.database.id
}

resource "aws_security_group" "endpoints" {
  name_prefix = "${var.name_prefix}-endpoints-"
  description = "Private AWS service endpoints"
  vpc_id      = aws_vpc.main.id
  egress      = []
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat(values(aws_route_table.application)[*].id, [aws_route_table.database.id])
  tags              = { Name = "${var.name_prefix}-s3" }
}

resource "aws_vpc_endpoint" "interface" {
  for_each = toset(var.interface_endpoint_services)

  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${data.aws_region.current.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  security_group_ids  = [aws_security_group.endpoints.id]
  subnet_ids          = slice(values(aws_subnet.application)[*].id, 0, var.interface_endpoint_az_count)
  tags                = { Name = "${var.name_prefix}-${replace(each.value, ".", "-")}" }
}

data "aws_region" "current" {}

data "aws_ec2_managed_prefix_list" "s3" {
  name = "com.amazonaws.${data.aws_region.current.region}.s3"
}
