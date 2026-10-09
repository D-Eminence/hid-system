import { Aws, CfnCondition, CfnParameter, Fn, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ce from 'aws-cdk-lib/aws-ce';
import type { Construct } from 'constructs';

type BudgetNotification = budgets.CfnBudget.NotificationWithSubscribersProperty;

export class HidCostGovernanceStack extends Stack {
  public constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    for (const [key, value] of Object.entries({
      Project: 'HID', Environment: 'account', Service: 'cost-governance', ManagedBy: 'CDK',
      Owner: 'HID', CostCenter: 'HID', DataClassification: 'healthcare-restricted',
    })) Tags.of(this).add(key, value);

    const email = new CfnParameter(this, 'CostNotificationEmail', {
      type: 'String',
      description: 'Required reviewed mailbox for HID budget and anomaly notifications',
      allowedPattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
    });
    const snsArn = new CfnParameter(this, 'CostNotificationSnsArn', {
      type: 'String', default: '',
      description: 'Optional existing SNS topic ARN for budget/anomaly notification fan-out',
      allowedPattern: '^$|^arn:[A-Za-z0-9-]+:sns:[A-Za-z0-9-]+:[0-9]{12}:[A-Za-z0-9_.-]+$',
    });
    const hasSns = new CfnCondition(this, 'HasCostNotificationSns', {
      expression: Fn.conditionNot(Fn.conditionEquals(snsArn.valueAsString, '')),
    });
    const cashLimit = new CfnParameter(this, 'MonthlyCashExposureBudgetUsd', {
      type: 'Number', default: 416.67, minValue: 1,
      description: 'Monthly cash-exposure planning limit; includes credits and is not a spending target',
    });
    const grossLimit = new CfnParameter(this, 'MonthlyGrossConsumptionBudgetUsd', {
      type: 'Number', default: 416.67, minValue: 1,
      description: 'Monthly gross AWS consumption limit before credits; set from the reviewed operating plan',
    });
    const anomalyThreshold = new CfnParameter(this, 'CostAnomalyThresholdUsd', {
      type: 'Number', default: 10, minValue: 1,
      description: 'Set to max(10 USD, 2% of the reviewed monthly gross budget)',
    });

    const subscribers = (): BudgetNotification['subscribers'] => [
      { subscriptionType: 'EMAIL', address: email.valueAsString },
      Fn.conditionIf(hasSns.logicalId,
        { SubscriptionType: 'SNS', Address: snsArn.valueAsString }, Aws.NO_VALUE),
    ];
    const notifications = (actual: readonly number[], forecast: readonly number[]): BudgetNotification[] => [
      ...actual.map((threshold) => ({
        notification: { comparisonOperator: 'GREATER_THAN', notificationType: 'ACTUAL',
          threshold, thresholdType: 'PERCENTAGE' }, subscribers: subscribers(),
      })),
      ...forecast.map((threshold) => ({
        notification: { comparisonOperator: 'GREATER_THAN', notificationType: 'FORECASTED',
          threshold, thresholdType: 'PERCENTAGE' }, subscribers: subscribers(),
      })),
    ];
    const costTypes = (includeCredit: boolean): budgets.CfnBudget.CostTypesProperty => ({
      includeCredit, includeDiscount: true, includeOtherSubscription: true,
      includeRecurring: true, includeRefund: true, includeSubscription: true,
      includeSupport: true, includeTax: true, includeUpfront: true,
      useAmortized: false, useBlended: false,
    });
    const tags = [
      { key: 'Project', value: 'HID' }, { key: 'Environment', value: 'account' },
      { key: 'Service', value: 'cost-governance' }, { key: 'ManagedBy', value: 'CDK' },
      { key: 'Owner', value: 'HID' }, { key: 'CostCenter', value: 'HID' },
      { key: 'DataClassification', value: 'healthcare-restricted' },
    ];

    new budgets.CfnBudget(this, 'CashExposureBudget', {
      budget: { budgetName: 'hid-monthly-cash-exposure', budgetType: 'COST', timeUnit: 'MONTHLY',
        budgetLimit: { amount: cashLimit.valueAsNumber, unit: 'USD' }, costTypes: costTypes(true) },
      notificationsWithSubscribers: notifications([50, 80, 100], [80, 100]),
      resourceTags: tags,
    });
    new budgets.CfnBudget(this, 'GrossConsumptionActualBudget', {
      budget: { budgetName: 'hid-monthly-gross-consumption', budgetType: 'COST', timeUnit: 'MONTHLY',
        budgetLimit: { amount: grossLimit.valueAsNumber, unit: 'USD' }, costTypes: costTypes(false) },
      notificationsWithSubscribers: notifications([50, 75, 90, 100], []),
      resourceTags: tags,
    });
    // AWS Budgets permits five notifications per budget. Forecast thresholds
    // are split into a second identically bounded gross view without changing
    // the tracked amount or enabling any automated action.
    new budgets.CfnBudget(this, 'GrossConsumptionForecastBudget', {
      budget: { budgetName: 'hid-monthly-gross-consumption-forecast', budgetType: 'COST', timeUnit: 'MONTHLY',
        budgetLimit: { amount: grossLimit.valueAsNumber, unit: 'USD' }, costTypes: costTypes(false) },
      notificationsWithSubscribers: notifications([], [80, 100]),
      resourceTags: tags,
    });

    const accountMonitor = new ce.CfnAnomalyMonitor(this, 'AccountServiceAnomalyMonitor', {
      monitorName: 'hid-account-service-cost-anomalies', monitorType: 'DIMENSIONAL',
      monitorDimension: 'SERVICE', resourceTags: tags,
    });
    const hidTagMonitor = new ce.CfnAnomalyMonitor(this, 'HidProjectTagAnomalyMonitor', {
      monitorName: 'hid-project-tag-cost-anomalies', monitorType: 'CUSTOM',
      monitorSpecification: JSON.stringify({ Tags: {
        Key: 'Project', Values: ['HID'], MatchOptions: ['EQUALS', 'CASE_SENSITIVE'],
      } }),
      resourceTags: tags,
    });
    new ce.CfnAnomalySubscription(this, 'CostAnomalySubscription', {
      subscriptionName: 'hid-cost-anomaly-notifications', frequency: 'DAILY',
      monitorArnList: [accountMonitor.attrMonitorArn, hidTagMonitor.attrMonitorArn],
      // DAILY Cost Explorer anomaly subscriptions deliver email. The optional
      // SNS fan-out remains on every AWS Budget threshold above.
      subscribers: [{ type: 'EMAIL', address: email.valueAsString }],
      thresholdExpression: Fn.sub(
        '{"Dimensions":{"Key":"ANOMALY_TOTAL_IMPACT_ABSOLUTE","MatchOptions":["GREATER_THAN_OR_EQUAL"],"Values":["${Threshold}"]}}',
        { Threshold: anomalyThreshold.valueAsString },
      ),
      resourceTags: tags,
    });
  }
}
