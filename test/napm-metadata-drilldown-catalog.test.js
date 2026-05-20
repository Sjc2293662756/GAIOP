process.env.NETINSIDE_HOST = process.env.NETINSIDE_HOST || '127.0.0.1';
process.env.NETINSIDE_USERNAME = process.env.NETINSIDE_USERNAME || 'tester';
process.env.NETINSIDE_PASSWORD = process.env.NETINSIDE_PASSWORD || 'tester';

const NapmMetadataService = require('../skills/openclaw-napm-query/services/NapmMetadataService');

describe('NapmMetadataService drilldown catalog', () => {
  afterEach(() => {
    NapmMetadataService.clearCache();
  });

  test('should load top-level drilldown catalog from static groups tree', async () => {
    const catalog = await NapmMetadataService.getTopLevelDrilldownCatalog({
      maxDepth: 2
    });

    const groupTypes = catalog.map((item) => item.groupType);
    expect(groupTypes).toContain('IPAddress');
    expect(groupTypes).toContain('BusinessGroup');
    expect(groupTypes).toContain('WebApplication');
  });

  test('should enumerate common IPAddress drilldown paths from static tree', async () => {
    const result = await NapmMetadataService.getDrilldownPathsForGroupType('IPAddress', {
      maxDepth: 2
    });

    expect(result).toBeTruthy();
    expect(result.groupType).toBe('IPAddress');
    expect(result.directChildren.map((item) => item.key)).toEqual(
      expect.arrayContaining(['ConnectedIPs', 'Applications', 'ConnectedGroups', 'OtherApps'])
    );
    expect(result.paths.map((item) => item.runtimePathText)).toEqual(
      expect.arrayContaining([
        'IPAddress > ConnectedIPs',
        'IPAddress > ConnectedIPs > ConnectedIP',
        'IPAddress > Applications',
        'IPAddress > Applications > DefinedApp',
        'IPAddress > ConnectedGroups',
        'IPAddress > ConnectedGroups > BusinessGroup',
        'IPAddress > OtherApps',
        'IPAddress > OtherApps > OtherApp'
      ])
    );
  });

  test('should enumerate common BusinessGroup drilldown paths from static tree', async () => {
    const result = await NapmMetadataService.getDrilldownPathsForGroupType('BusinessGroup', {
      maxDepth: 2
    });

    expect(result).toBeTruthy();
    expect(result.groupType).toBe('BusinessGroup');
    expect(result.directChildren.map((item) => item.key)).toEqual(
      expect.arrayContaining(['MemberIPs', 'ConnectedIPs', 'Applications', 'IPConversations'])
    );
    expect(result.paths.map((item) => item.runtimePathText)).toEqual(
      expect.arrayContaining([
        'BusinessGroup > MemberIPs',
        'BusinessGroup > MemberIPs > IPAddress',
        'BusinessGroup > ConnectedIPs',
        'BusinessGroup > ConnectedIPs > IPAddress',
        'BusinessGroup > Applications',
        'BusinessGroup > Applications > DefinedApp',
        'BusinessGroup > IPConversations',
        'BusinessGroup > IPConversations > IPConversation'
      ])
    );
  });

  test('should enumerate common WebApplication drilldown paths from static tree', async () => {
    const result = await NapmMetadataService.getDrilldownPathsForGroupType('WebApplication', {
      maxDepth: 2
    });

    expect(result).toBeTruthy();
    expect(result.groupType).toBe('WebApplication');
    expect(result.directChildren.map((item) => item.key)).toEqual(
      expect.arrayContaining(['ServerIPs', 'ClientIPs', 'Users', 'PageFamilies', 'OriginatingIPs'])
    );
    expect(result.paths.map((item) => item.runtimePathText)).toEqual(
      expect.arrayContaining([
        'WebApplication > ServerIPs',
        'WebApplication > ServerIPs > IPAddress',
        'WebApplication > ClientIPs',
        'WebApplication > ClientIPs > IPAddress',
        'WebApplication > Users',
        'WebApplication > Users > User',
        'WebApplication > PageFamilies',
        'WebApplication > PageFamilies > PageFamily',
        'WebApplication > OriginatingIPs',
        'WebApplication > OriginatingIPs > OriginatingIP'
      ])
    );
  });
});
