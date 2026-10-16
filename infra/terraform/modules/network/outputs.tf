output "vpc_id" { value = aws_vpc.main.id }
output "public_subnet_ids" { value = values(aws_subnet.public)[*].id }
output "application_subnet_ids" { value = values(aws_subnet.application)[*].id }
output "database_subnet_ids" { value = values(aws_subnet.database)[*].id }
output "application_route_table_ids" { value = values(aws_route_table.application)[*].id }
output "endpoint_security_group_id" { value = aws_security_group.endpoints.id }
output "s3_prefix_list_id" { value = data.aws_ec2_managed_prefix_list.s3.id }
